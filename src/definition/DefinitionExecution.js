import getPropertyValue from '../getPropertyValue';
import {DefinitionApi} from '../Api';
import {brokerSafeId} from '../shared';
import {cloneContent, cloneMessage, pushParent, cloneParent} from '../messageHelper';

export default function DefinitionExecution(definition, context) {
  const {id, type, broker, logger, environment} = definition;

  const processes = context.getProcesses();
  const runningProcesses = [];
  const processIds = processes.map(({id: childId}) => childId);
  let executableProcesses = context.getExecutableProcesses();

  const postponed = [];
  broker.assertExchange('execution', 'topic', {autoDelete: false, durable: true});

  let activityQ, status = 'init', executionId, stopped, activated, initMessage, completed = false;

  const definitionExecution = {
    id,
    type,
    broker,
    get environment() {
      return environment;
    },
    get executionId() {
      return executionId;
    },
    get completed() {
      return completed;
    },
    get status() {
      return status;
    },
    get stopped() {
      return stopped;
    },
    get postponedCount() {
      return postponed.length;
    },
    get isRunning() {
      if (activated) return true;
      return false;
    },
    getExecutableProcesses() {
      return executableProcesses.slice();
    },
    processes: runningProcesses,
    createMessage,
    getApi,
    getState,
    getPostponed,
    getProcessById,
    getProcesses,
    getRunningProcesses,
    execute,
    resume,
    recover,
    stop,
  };

  return definitionExecution;

  function execute(executeMessage) {
    if (!executeMessage) throw new Error('Definition execution requires message');
    const {content, fields} = executeMessage;
    if (!content || !content.executionId) throw new Error('Definition execution requires execution id');

    const isRedelivered = fields.redelivered;
    executionId = content.executionId;

    initMessage = cloneMessage(executeMessage, {executionId, state: 'start'});

    stopped = false;

    activityQ = broker.assertQueue(`execute-${executionId}-q`, {durable: true, autoDelete: false});

    if (isRedelivered) {
      return resume();
    }

    if (content.processId) {
      const startWithProcess = definition.getProcessById(content.processId);
      if (startWithProcess) executableProcesses = [startWithProcess];
    }

    logger.debug(`<${executionId} (${id})> execute definition`);
    runningProcesses.push(...executableProcesses);
    activate(executableProcesses);
    start();
    return true;
  }

  function start() {
    if (!processIds.length) {
      return publishCompletionMessage('completed');
    }
    if (!executableProcesses.length) {
      return complete('error', {error: new Error('No executable process')});
    }

    status = 'start';

    executableProcesses.forEach((p) => p.init());
    executableProcesses.forEach((p) => p.run());

    postponed.splice(0);
    activityQ.assertConsumer(onProcessMessage, {prefetch: 1000, consumerTag: `_definition-activity-${executionId}`});
  }

  function resume() {
    logger.debug(`<${executionId} (${id})> resume`, status, 'definition execution');

    if (completed) return complete('completed');

    activate(runningProcesses);
    postponed.splice(0);
    activityQ.consume(onProcessMessage, {prefetch: 1000, consumerTag: `_definition-activity-${executionId}`});

    if (completed) return complete('completed');
    switch (status) {
      case 'init':
        return start();
      case 'executing': {
        if (!postponed.length) return complete('completed');
        break;
      }
    }

    runningProcesses.forEach((p) => p.resume());
  }

  function recover(state) {
    if (!state) return definitionExecution;
    executionId = state.executionId;

    stopped = state.stopped;
    completed = state.completed;
    status = state.status;

    logger.debug(`<${executionId} (${id})> recover`, status, 'definition execution');

    runningProcesses.splice(0);

    state.processes.map((processState) => {
      const instance = context.getNewProcessById(processState.id);
      if (!instance) return;
      instance.recover(processState);
      runningProcesses.push(instance);
    });

    return definitionExecution;
  }

  function stop() {
    getApi().stop();
  }

  function activate(processList) {
    broker.subscribeTmp('api', '#', onApiMessage, {noAck: true, consumerTag: '_definition-api-consumer'});
    processList.forEach(activateProcess);
    activated = true;
  }

  function activateProcess(bp) {
    bp.broker.subscribeTmp('message', 'message.outbound', onMessageOutbound, {noAck: true, consumerTag: '_definition-outbound-message-consumer'});
    bp.broker.subscribeTmp('event', 'activity.signal', onDelegateMessage, {noAck: true, consumerTag: '_definition-signal-consumer', priority: 200});
    bp.broker.subscribeTmp('event', 'activity.message', onDelegateMessage, {noAck: true, consumerTag: '_definition-message-consumer', priority: 200});
    bp.broker.subscribeTmp('event', 'activity.call', onCallActivity, {noAck: true, consumerTag: '_definition-call-consumer', priority: 200});
    bp.broker.subscribeTmp('event', '#', onChildEvent, {noAck: true, consumerTag: '_definition-activity-consumer', priority: 100});
  }

  function onChildEvent(routingKey, originalMessage) {
    const message = cloneMessage(originalMessage);
    const content = message.content;
    const parent = content.parent = content.parent || {};

    const isDirectChild = processIds.indexOf(content.id) > -1;
    if (isDirectChild) {
      parent.executionId = executionId;
    } else {
      content.parent = pushParent(parent, {id, type, executionId});
    }

    broker.publish('event', routingKey, content, {...message.properties, mandatory: false});
    if (!isDirectChild) return;

    activityQ.queueMessage(message.fields, cloneContent(content), message.properties);
  }

  function deactivate() {
    broker.cancel('_definition-api-consumer');
    broker.cancel(`_definition-activity-${executionId}`);
    runningProcesses.forEach(deactivateProcess);
    activated = false;
  }

  function deactivateProcess(bp) {
    bp.broker.cancel('_definition-outbound-message-consumer');
    bp.broker.cancel('_definition-activity-consumer');
    bp.broker.cancel('_definition-signal-consumer');
    bp.broker.cancel('_definition-message-consumer');
    bp.broker.cancel('_definition-call-consumer');
  }

  function onProcessMessage(routingKey, message) {
    const content = message.content;
    const isRedelivered = message.fields.redelivered;
    const {id: childId, type: activityType, executionId: childExecutionId, inbound} = content;

    if (isRedelivered && message.properties.persistent === false) return;

    switch (routingKey) {
      case 'execution.stop': {
        if (childExecutionId === executionId) {
          message.ack();
          return onStopped();
        }
        break;
      }
      case 'process.leave': {
        return onProcessCompleted();
      }
    }

    stateChangeMessage(true);

    switch (routingKey) {
      case 'process.discard':
      case 'process.enter':
        status = 'executing';
        break;
      case 'process.end':
        if (inbound && inbound.length) {
          const calledFrom = inbound[0];

          getApiByProcess({content: calledFrom}).signal({
            executionId: calledFrom.executionId,
            output: {...content.output},
          });
        } else {
          Object.assign(environment.output, content.output);
        }
        break;
      case 'process.error': {
        if (inbound && inbound.length) {
          const calledFrom = inbound[0];

          getApiByProcess({content: calledFrom}).sendApiMessage('error', {
            executionId: calledFrom.executionId,
            error: content.error,
          }, {mandatory: true, type: 'error'});
        } else {
          runningProcesses.slice().forEach((p) => {
            if (p.id !== childId) p.stop();
          });

          complete('error', {error: content.error});
        }
        break;
      }
    }

    function stateChangeMessage(postponeMessage = true) {
      const previousMsg = popPostponed(childExecutionId);
      if (previousMsg) previousMsg.ack();
      if (postponeMessage) postponed.push(message);
    }

    function popPostponed(postponedExecutionId) {
      const idx = postponed.findIndex((msg) => msg.content.executionId === postponedExecutionId);
      if (idx > -1) {
        return postponed.splice(idx, 1)[0];
      }
    }

    function onProcessCompleted() {
      stateChangeMessage(false);
      if (isRedelivered) return message.ack();

      logger.debug(`<${executionId} (${id})> left <${childExecutionId} (${childId})> (${activityType}), pending runs ${postponed.length}`);

      if (inbound && inbound.length) {
        const bp = removeProcessByExecutionId(childExecutionId);
        deactivateProcess(bp);
      }

      if (!postponed.length) {
        message.ack();
        complete('completed');
      }
    }

    function onStopped() {
      logger.debug(`<${executionId} (${id})> stop definition execution (stop process executions ${runningProcesses.length})`);
      activityQ.close();
      deactivate();
      runningProcesses.slice().forEach((p) => {
        p.stop();
      });
      stopped = true;
      return broker.publish('execution', `execution.stopped.${executionId}`, {
        ...initMessage.content,
        ...content,
      }, {type: 'stopped', persistent: false});
    }
  }

  function onApiMessage(routingKey, message) {
    const messageType = message.properties.type;
    const delegate = message.properties.delegate;

    if (delegate && id === message.content.id) {
      const referenceId = getPropertyValue(message, 'content.message.id');
      startProcessesByMessage({referenceId, referenceType: messageType});
    }

    if (delegate) {
      for (const bp of runningProcesses.slice()) {
        bp.broker.publish('api', routingKey, cloneContent(message.content), message.properties);
      }
    }

    if (executionId !== message.content.executionId) return;

    switch (messageType) {
      case 'stop':
        activityQ.queueMessage({routingKey: 'execution.stop'}, cloneContent(message.content), {persistent: false});
        break;
    }
  }

  function startProcessesByMessage(reference) {
    if (processes.length < 2) return;
    for (const bp of processes) {
      if (bp.isExecutable) continue;
      if (!bp.getStartActivities(reference).length) continue;

      logger.debug(`<${executionId} (${id})> start <${bp.id}>`);

      if (!bp.executionId) {
        activateProcess(bp);
        runningProcesses.push(bp);
        bp.init();
        return bp.run();
      }

      const targetProcess = context.getNewProcessById(bp.id);
      activateProcess(targetProcess);
      runningProcesses.push(targetProcess);
      targetProcess.init();
      targetProcess.run();
    }
  }

  function onMessageOutbound(routingKey, message) {
    const content = message.content;
    const {target, source} = content;

    logger.debug(`<${executionId} (${id})> conveying message from <${source.processId}.${source.id}> to`, target.id ? `<${target.processId}.${target.id}>` : `<${target.processId}>`);

    const targetProcesses = getProcessesById(target.processId);
    if (!targetProcesses.length) return;

    let targetProcess, found;
    for (const bp of targetProcesses) {
      if (!bp.executionId) {
        targetProcess = bp;
        continue;
      }
      bp.sendMessage(message);
      found = true;
    }

    if (found) return;

    targetProcess = targetProcess || context.getNewProcessById(target.processId);

    activateProcess(targetProcess);
    runningProcesses.push(targetProcess);
    targetProcess.init();
    targetProcess.run();
    targetProcess.sendMessage(message);
  }

  function onCallActivity(routingKey, message) {
    const content = message.content;
    const {calledElement, id: fromId, executionId: fromExecutionId, name: fromName, parent: fromParent} = content;

    const bpExecutionId = `${brokerSafeId(calledElement)}_${fromExecutionId}`;
    if (content.isRecovered) {
      if (getProcessByExecutionId(bpExecutionId)) return;
    }

    const targetProcess = context.getNewProcessById(calledElement, {
      settings: {
        calledFrom: cloneContent({
          id: fromId,
          name: fromName,
          executionId: content.executionId,
          parent: content.parent,
        }),
      },
    });

    if (!targetProcess) return;

    logger.debug(`<${executionId} (${id})> call from <${fromParent.id}.${fromId}> to <${calledElement}>`);

    activateProcess(targetProcess);
    runningProcesses.push(targetProcess);
    targetProcess.init(bpExecutionId);
    targetProcess.run({inbound: [cloneContent(content)]});
  }

  function onDelegateMessage(routingKey, executeMessage) {
    const content = executeMessage.content;
    const messageType = executeMessage.properties.type;
    const delegateMessage = executeMessage.content.message;

    const reference = context.getActivityById(delegateMessage.id);
    const message = reference && reference.resolve(executeMessage);

    logger.debug(`<${executionId} (${id})>`, reference ? `${messageType} <${delegateMessage.id}>` : `anonymous ${messageType}`, `event received from <${content.parent.id}.${content.id}>. Delegating.`);

    getApi().sendApiMessage(messageType, {
      source: {
        id: content.id,
        executionId: content.executionId,
        type: content.type,
        parent: cloneParent(content.parent),
      },
      message,
      originalMessage: content.message,
    }, {delegate: true, type: messageType});

    broker.publish('event', `definition.${messageType}`, createMessage({
      message: message && cloneContent(message),
    }), {type: messageType});
  }

  function getProcesses() {
    const result = runningProcesses.slice();
    for (const bp of processes) {
      if (!result.find((runningBp) => bp.id === runningBp.id)) result.push(bp);
    }
    return result;
  }

  function getProcessById(processId) {
    return getProcesses().find((bp) => bp.id === processId);
  }

  function getProcessesById(processId) {
    return getProcesses().filter((bp) => bp.id === processId);
  }

  function getProcessByExecutionId(processExecutionId) {
    return runningProcesses.find((bp) => bp.executionId === processExecutionId);
  }

  function getRunningProcesses() {
    return runningProcesses.filter((bp) => bp.executionId);
  }

  function getState() {
    return {
      executionId,
      stopped,
      completed,
      status,
      processes: runningProcesses.map((bp) => bp.getState()),
    };
  }

  function removeProcessByExecutionId(processExecutionId) {
    const idx = runningProcesses.findIndex((p) => p.executionId === processExecutionId);
    if (idx === -1) return;
    return runningProcesses.splice(idx, 1)[0];
  }

  function getPostponed(...args) {
    return runningProcesses.reduce((result, p) => {
      result = result.concat(p.getPostponed(...args));
      return result;
    }, []);
  }

  function complete(completionType, content, options) {
    deactivate();
    logger.debug(`<${executionId} (${id})> definition execution ${completionType} in ${Date.now() - initMessage.properties.timestamp}ms`);
    if (!content) content = createMessage();
    completed = true;
    if (status !== 'terminated') status = completionType;
    broker.deleteQueue(activityQ.name);

    return broker.publish('execution', `execution.${completionType}.${executionId}`, {
      ...initMessage.content,
      output: {...environment.output},
      ...content,
      state: completionType,
    }, {type: completionType, mandatory: completionType === 'error', ...options});
  }

  function publishCompletionMessage(completionType, content) {
    deactivate();
    logger.debug(`<${executionId} (${id})> ${completionType}`);
    if (!content) content = createMessage();
    return broker.publish('execution', `execution.${completionType}.${executionId}`, content, { type: completionType });
  }

  function createMessage(content = {}) {
    return {
      id,
      type,
      executionId,
      status,
      ...content,
    };
  }

  function getApi(apiMessage) {
    if (!apiMessage) apiMessage = initMessage || {content: createMessage()};

    const content = apiMessage.content;
    if (content.executionId !== executionId) {
      return getApiByProcess(apiMessage);
    }

    const api = DefinitionApi(broker, apiMessage);

    api.getExecuting = function getExecuting() {
      return postponed.reduce((result, msg) => {
        if (msg.content.executionId === content.executionId) return result;
        result.push(getApi(msg));
        return result;
      }, []);
    };

    return api;
  }

  function getApiByProcess(message) {
    const content = message.content;
    let api = getApiByExecutionId(content.executionId, message);
    if (api) return api;

    if (!content.parent) return;

    api = getApiByExecutionId(content.parent.executionId, message);
    if (api) return api;

    if (!content.parent.path) return;

    for (let i = 0; i < content.parent.path.length; i++) {
      api = getApiByExecutionId(content.parent.path[i].executionId, message);
      if (api) return api;
    }
  }

  function getApiByExecutionId(parentExecutionId, message) {
    const processInstance = getProcessByExecutionId(parentExecutionId);
    if (!processInstance) return;
    return processInstance.getApi(message);
  }
}
