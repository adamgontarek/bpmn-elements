"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _ActivityExecution = _interopRequireDefault(require("./ActivityExecution"));

var _BpmnIO = _interopRequireDefault(require("../io/BpmnIO"));

var _shared = require("../shared");

var _Api = require("../Api");

var _EventBroker = require("../EventBroker");

var _MessageFormatter = require("../MessageFormatter");

var _messageHelper = require("../messageHelper");

var _Errors = require("../error/Errors");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const activityDefSymbol = Symbol.for('activityDefinition');
const bpmnIoSymbol = Symbol.for('bpmnIo');
const consumingSymbol = Symbol.for('consuming');
const countersSymbol = Symbol.for('counters');
const eventDefinitionsSymbol = Symbol.for('eventDefinitions');
const execSymbol = Symbol.for('exec');
const executeMessageSymbol = Symbol.for('executeMessage');
const extensionsSymbol = Symbol.for('extensions');
const flagsSymbol = Symbol.for('flags');
const flowsSymbol = Symbol.for('flows');
const formatterSymbol = Symbol.for('formatter');
const messageHandlersSymbol = Symbol.for('messageHandlers');
const stateMessageSymbol = Symbol.for('stateMessage');
var _default = Activity;
exports.default = _default;

function Activity(Behaviour, activityDef, context) {
  const {
    id,
    type = 'activity',
    name,
    behaviour = {}
  } = activityDef;
  const {
    attachedTo: attachedToRef,
    eventDefinitions
  } = behaviour;
  this[activityDefSymbol] = activityDef;
  this.id = id;
  this.type = type;
  this.name = name;
  this.behaviour = { ...behaviour,
    eventDefinitions
  };
  this.Behaviour = Behaviour;
  this.parent = activityDef.parent ? (0, _messageHelper.cloneParent)(activityDef.parent) : {};
  this.logger = context.environment.Logger(type.toLowerCase());
  this.environment = context.environment;
  this.context = context;
  this[countersSymbol] = {
    taken: 0,
    discarded: 0
  };
  let attachedToActivity, attachedTo;

  if (attachedToRef) {
    attachedTo = attachedToRef.id;
    attachedToActivity = context.getActivityById(attachedToRef.id);
  }

  const {
    broker,
    on,
    once,
    waitFor,
    emitFatal
  } = (0, _EventBroker.ActivityBroker)(this);
  this.broker = broker;
  this.on = on;
  this.once = once;
  this.waitFor = waitFor;
  this.emitFatal = emitFatal;
  const inboundSequenceFlows = context.getInboundSequenceFlows(id);
  const inboundAssociations = context.getInboundAssociations(id);
  const inboundTriggers = attachedToActivity ? [attachedToActivity] : inboundSequenceFlows.slice();
  const outboundSequenceFlows = context.getOutboundSequenceFlows(id);
  const flows = this[flowsSymbol] = {
    inboundSequenceFlows,
    inboundAssociations,
    inboundJoinFlows: [],
    inboundTriggers,
    outboundSequenceFlows,
    outboundEvaluator: new OutboundEvaluator(this, outboundSequenceFlows)
  };
  const isForCompensation = !!behaviour.isForCompensation;
  const isParallelJoin = activityDef.isParallelGateway && flows.inboundSequenceFlows.length > 1;
  this[flagsSymbol] = {
    isEnd: flows.outboundSequenceFlows.length === 0,
    isStart: flows.inboundSequenceFlows.length === 0 && !attachedTo && !behaviour.triggeredByEvent && !isForCompensation,
    isSubProcess: activityDef.isSubProcess,
    isMultiInstance: !!behaviour.loopCharacteristics,
    isForCompensation,
    attachedTo,
    isTransaction: activityDef.isTransaction,
    isParallelJoin,
    isThrowing: activityDef.isThrowing
  };
  this[execSymbol] = {};
  this[messageHandlersSymbol] = {
    onInbound: isParallelJoin ? this._onJoinInbound.bind(this) : this._onInbound.bind(this),
    onRunMessage: this._onRunMessage.bind(this),
    onApiMessage: this._onApiMessage.bind(this),
    onExecutionMessage: this._onExecutionMessage.bind(this)
  };

  const onInboundEvent = this._onInboundEvent.bind(this);

  broker.assertQueue('inbound-q', {
    durable: true,
    autoDelete: false
  });

  if (isForCompensation) {
    for (const trigger of inboundAssociations) {
      trigger.broker.subscribeTmp('event', '#', onInboundEvent, {
        noAck: true,
        consumerTag: `_inbound-${id}`
      });
    }
  } else {
    for (const trigger of inboundTriggers) {
      if (trigger.isSequenceFlow) trigger.broker.subscribeTmp('event', 'flow.#', onInboundEvent, {
        noAck: true,
        consumerTag: `_inbound-${id}`
      });else trigger.broker.subscribeTmp('event', 'activity.#', onInboundEvent, {
        noAck: true,
        consumerTag: `_inbound-${id}`
      });
    }
  }

  this[eventDefinitionsSymbol] = eventDefinitions && eventDefinitions.map(ed => new ed.Behaviour(this, ed, this.context));
}

const proto = Activity.prototype;
Object.defineProperty(proto, 'counters', {
  enumerable: true,

  get() {
    return { ...this[countersSymbol]
    };
  }

});
Object.defineProperty(proto, 'execution', {
  enumerable: true,

  get() {
    return this[execSymbol].execution;
  }

});
Object.defineProperty(proto, 'executionId', {
  enumerable: true,

  get() {
    return this[execSymbol].executionId;
  }

});
Object.defineProperty(proto, 'bpmnIo', {
  enumerable: true,

  get() {
    if (bpmnIoSymbol in this) return this[bpmnIoSymbol];
    const bpmnIo = this[bpmnIoSymbol] = (0, _BpmnIO.default)(this, this.context);
    return bpmnIo;
  }

});
Object.defineProperty(proto, 'extensions', {
  enumerable: true,

  get() {
    if (extensionsSymbol in this) return this[extensionsSymbol];
    const extensions = this[extensionsSymbol] = this.context.loadExtensions(this);
    return extensions;
  }

});
Object.defineProperty(proto, 'formatter', {
  enumerable: true,

  get() {
    let formatter = this[formatterSymbol];
    if (formatter) return formatter;
    const broker = this.broker;
    formatter = this[formatterSymbol] = (0, _MessageFormatter.Formatter)({
      id: this.id,
      broker,
      logger: this.logger
    }, broker.getQueue('format-run-q'));
    return formatter;
  }

});
Object.defineProperty(proto, 'isRunning', {
  enumerable: true,

  get() {
    if (!this[consumingSymbol]) return false;
    return !!this.status;
  }

});
Object.defineProperty(proto, 'outbound', {
  enumerable: true,

  get() {
    return this[flowsSymbol].outboundSequenceFlows;
  }

});
Object.defineProperty(proto, 'inbound', {
  enumerable: true,

  get() {
    return this[flowsSymbol].inboundSequenceFlows;
  }

});
Object.defineProperty(proto, 'isEnd', {
  enumerable: true,

  get() {
    return this[flagsSymbol].isEnd;
  }

});
Object.defineProperty(proto, 'isStart', {
  enumerable: true,

  get() {
    return this[flagsSymbol].isStart;
  }

});
Object.defineProperty(proto, 'isSubProcess', {
  enumerable: true,

  get() {
    return this[flagsSymbol].isSubProcess;
  }

});
Object.defineProperty(proto, 'isMultiInstance', {
  enumerable: true,

  get() {
    return this[flagsSymbol].isMultiInstance;
  }

});
Object.defineProperty(proto, 'isThrowing', {
  enumerable: true,

  get() {
    return this[flagsSymbol].isThrowing;
  }

});
Object.defineProperty(proto, 'isForCompensation', {
  enumerable: true,

  get() {
    return this[flagsSymbol].isForCompensation;
  }

});
Object.defineProperty(proto, 'triggeredByEvent', {
  enumerable: true,

  get() {
    return this[activityDefSymbol].triggeredByEvent;
  }

});
Object.defineProperty(proto, 'attachedTo', {
  enumerable: true,

  get() {
    const attachedToId = this[flagsSymbol].attachedTo;
    if (!attachedToId) return null;
    return this.getActivityById(attachedToId);
  }

});
Object.defineProperty(proto, 'eventDefinitions', {
  enumerable: true,

  get() {
    return this[eventDefinitionsSymbol];
  }

});

proto.activate = function activate() {
  if (this[flagsSymbol].isForCompensation) return;
  return this._consumeInbound();
};

proto.deactivate = function deactivate() {
  const broker = this.broker;
  broker.cancel('_run-on-inbound');
  broker.cancel('_format-consumer');
};

proto.init = function init(initContent) {
  const id = this.id;
  const exec = this[execSymbol];
  const executionId = exec.initExecutionId = exec.initExecutionId || (0, _shared.getUniqueId)(id);
  this.logger.debug(`<${id}> initialized with executionId <${executionId}>`);

  this._publishEvent('init', this._createMessage({ ...initContent,
    executionId
  }));
};

proto.run = function run(runContent) {
  const id = this.id;
  if (this.isRunning) throw new Error(`activity <${id}> is already running`);
  const exec = this[execSymbol];
  const executionId = exec.executionId = exec.initExecutionId || (0, _shared.getUniqueId)(id);
  exec.initExecutionId = null;

  this._consumeApi();

  const content = this._createMessage({ ...runContent,
    executionId
  });

  const broker = this.broker;
  broker.publish('run', 'run.enter', content);
  broker.publish('run', 'run.start', (0, _messageHelper.cloneContent)(content));

  this._consumeRunQ();
};

proto.recover = function recover(state) {
  if (this.isRunning) throw new Error(`cannot recover running activity <${this.id}>`);
  if (!state) return;
  this.stopped = state.stopped;
  this.status = state.status;
  const exec = this[execSymbol];
  exec.executionId = state.executionId;
  this[countersSymbol] = { ...this[countersSymbol],
    ...state.counters
  };

  if (state.execution) {
    exec.execution = new _ActivityExecution.default(this, this.context).recover(state.execution);
  }

  this.broker.recover(state.broker);
  return this;
};

proto.resume = function resume() {
  if (this[consumingSymbol]) {
    throw new Error(`cannot resume running activity <${this.id}>`);
  }

  if (!this.status) return this.activate();
  this.stopped = false;

  this._consumeApi();

  const content = this._createMessage();

  this.broker.publish('run', 'run.resume', content, {
    persistent: false
  });

  this._consumeRunQ();
};

proto.discard = function discard(discardContent) {
  if (!this.status) return this._runDiscard(discardContent);
  const execution = this[execSymbol].execution;
  if (execution && !execution.completed) return execution.discard();

  this._deactivateRunConsumers();

  const broker = this.broker;
  broker.getQueue('run-q').purge();
  broker.publish('run', 'run.discard', (0, _messageHelper.cloneContent)(this[stateMessageSymbol].content));

  this._consumeRunQ();
};

proto.stop = function stop() {
  if (!this[consumingSymbol]) return;
  return this.getApi().stop();
};

proto.next = function next() {
  if (!this.environment.settings.step) return;
  const stateMessage = this[stateMessageSymbol];
  if (!stateMessage) return;
  if (this.status === 'executing') return false;
  if (this.status === 'formatting') return false;
  const current = stateMessage;
  stateMessage.ack();
  return current;
};

proto.shake = function shake() {
  this._shakeOutbound({
    content: this._createMessage()
  });
};

proto.evaluateOutbound = function evaluateOutbound(fromMessage, discardRestAtTake, callback) {
  return this[flowsSymbol].outboundEvaluator.evaluate(fromMessage, discardRestAtTake, callback);
};

proto.getState = function getState() {
  const msg = this._createMessage();

  const exec = this[execSymbol];
  return { ...msg,
    executionId: exec.executionId,
    stopped: this.stopped,
    behaviour: { ...this.behaviour
    },
    counters: this.counters,
    broker: this.broker.getState(true),
    execution: exec.execution && exec.execution.getState()
  };
};

proto.getApi = function getApi(message) {
  const execution = this[execSymbol].execution;
  if (execution && !execution.completed) return execution.getApi(message);
  return (0, _Api.ActivityApi)(this.broker, message || this[stateMessageSymbol]);
};

proto.getActivityById = function getActivityById(elementId) {
  return this.context.getActivityById(elementId);
};

proto._runDiscard = function runDiscard(discardContent = {}) {
  const exec = this[execSymbol];
  const executionId = exec.executionId = exec.initExecutionId || (0, _shared.getUniqueId)(this.id);
  exec.initExecutionId = null;

  this._consumeApi();

  const content = this._createMessage({ ...discardContent,
    executionId
  });

  this.broker.publish('run', 'run.discard', content);

  this._consumeRunQ();
};

proto._discardRun = function discardRun() {
  const status = this.status;
  if (!status) return;
  const execution = this[execSymbol].execution;
  if (execution && !execution.completed) return;

  switch (status) {
    case 'executing':
    case 'error':
    case 'discarded':
      return;
  }

  this._deactivateRunConsumers();

  if (this.extensions) this.extensions.deactivate();
  const broker = this.broker;
  broker.getQueue('run-q').purge();
  broker.publish('run', 'run.discard', (0, _messageHelper.cloneContent)(this[stateMessageSymbol].content));

  this._consumeRunQ();
};

proto._shakeOutbound = function shakeOutbound(sourceMessage) {
  const message = (0, _messageHelper.cloneMessage)(sourceMessage);
  message.content.sequence = message.content.sequence || [];
  message.content.sequence.push({
    id: this.id,
    type: this.type
  });
  const broker = this.broker;
  this.broker.publish('api', 'activity.shake.start', message.content, {
    persistent: false,
    type: 'shake'
  });

  if (this[flagsSymbol].isEnd) {
    return broker.publish('event', 'activity.shake.end', message.content, {
      persistent: false,
      type: 'shake'
    });
  }

  for (const flow of this[flowsSymbol].outboundSequenceFlows) flow.shake(message);
};

proto._consumeInbound = function consumeInbound() {
  if (this.status) return;
  const inboundQ = this.broker.getQueue('inbound-q');

  if (this[flagsSymbol].isParallelJoin) {
    return inboundQ.consume(this[messageHandlersSymbol].onInbound, {
      consumerTag: '_run-on-inbound',
      prefetch: 1000
    });
  }

  return inboundQ.consume(this[messageHandlersSymbol].onInbound, {
    consumerTag: '_run-on-inbound'
  });
};

proto._onInbound = function onInbound(routingKey, message) {
  message.ack();
  const id = this.id;
  const broker = this.broker;
  broker.cancel('_run-on-inbound');
  const content = message.content;
  const inbound = [(0, _messageHelper.cloneContent)(content)];

  switch (routingKey) {
    case 'association.take':
    case 'flow.take':
    case 'activity.enter':
      return this.run({
        message: content.message,
        inbound
      });

    case 'flow.discard':
    case 'activity.discard':
      {
        let discardSequence;
        if (content.discardSequence) discardSequence = content.discardSequence.slice();
        return this._runDiscard({
          inbound,
          discardSequence
        });
      }

    case 'association.complete':
      {
        broker.cancel('_run-on-inbound');
        const compensationId = `${(0, _shared.brokerSafeId)(id)}_${(0, _shared.brokerSafeId)(content.sequenceId)}`;
        this.logger.debug(`<${id}> completed compensation with id <${compensationId}>`);
        return this._publishEvent('compensation.end', this._createMessage({
          executionId: compensationId
        }));
      }
  }
};

proto._onJoinInbound = function onJoinInbound(routingKey, message) {
  const {
    content
  } = message;
  const {
    inboundSequenceFlows,
    inboundJoinFlows,
    inboundTriggers
  } = this[flowsSymbol];
  const idx = inboundJoinFlows.findIndex(msg => msg.content.id === content.id);
  inboundJoinFlows.push(message);
  if (idx > -1) return;
  const allTouched = inboundJoinFlows.length >= inboundTriggers.length;

  if (!allTouched) {
    const remaining = inboundSequenceFlows.filter((inb, i, list) => list.indexOf(inb) === i).length - inboundJoinFlows.length;
    return this.logger.debug(`<${this.id}> inbound ${message.content.action} from <${message.content.id}>, ${remaining} remaining`);
  }

  const evaluatedInbound = inboundJoinFlows.splice(0);
  let taken;
  const inbound = evaluatedInbound.map(im => {
    if (im.fields.routingKey === 'flow.take') taken = true;
    im.ack();
    return (0, _messageHelper.cloneContent)(im.content);
  });
  const discardSequence = !taken && evaluatedInbound.reduce((result, im) => {
    if (!im.content.discardSequence) return result;

    for (const sourceId of im.content.discardSequence) {
      if (result.indexOf(sourceId) === -1) result.push(sourceId);
    }

    return result;
  }, []);
  this.broker.cancel('_run-on-inbound');
  if (!taken) return this._runDiscard({
    inbound,
    discardSequence
  });
  return this.run({
    inbound
  });
};

proto._onInboundEvent = function onInboundEvent(routingKey, message) {
  const {
    fields,
    content,
    properties
  } = message;
  const id = this.id;
  const inboundQ = this.broker.getQueue('inbound-q');

  switch (routingKey) {
    case 'activity.enter':
    case 'activity.discard':
      {
        if (content.id === this[flagsSymbol].attachedTo) {
          inboundQ.queueMessage(fields, (0, _messageHelper.cloneContent)(content), properties);
        }

        break;
      }

    case 'flow.shake':
      {
        return this._shakeOutbound(message);
      }

    case 'association.take':
    case 'flow.take':
    case 'flow.discard':
      return inboundQ.queueMessage(fields, (0, _messageHelper.cloneContent)(content), properties);

    case 'association.discard':
      {
        this.logger.debug(`<${id}> compensation discarded`);
        return inboundQ.purge();
      }

    case 'association.complete':
      {
        if (!this[flagsSymbol].isForCompensation) break;
        inboundQ.queueMessage(fields, (0, _messageHelper.cloneContent)(content), properties);
        const compensationId = `${(0, _shared.brokerSafeId)(id)}_${(0, _shared.brokerSafeId)(content.sequenceId)}`;

        this._publishEvent('compensation.start', this._createMessage({
          executionId: compensationId,
          placeholder: true
        }));

        this.logger.debug(`<${id}> start compensation with id <${compensationId}>`);
        return this._consumeInbound();
      }
  }
};

proto._consumeRunQ = function consumeRunQ() {
  if (this[consumingSymbol]) return;
  this[consumingSymbol] = true;
  this.broker.getQueue('run-q').assertConsumer(this[messageHandlersSymbol].onRunMessage, {
    exclusive: true,
    consumerTag: '_activity-run'
  });
};

proto._onRunMessage = function onRunMessage(routingKey, message, messageProperties) {
  switch (routingKey) {
    case 'run.outbound.discard':
    case 'run.outbound.take':
    case 'run.next':
      return this._continueRunMessage(routingKey, message, messageProperties);

    case 'run.resume':
      {
        return this._onResumeMessage(message);
      }
  }

  const preStatus = this.status;
  this.status = 'formatting';
  return this.formatter(message, (err, formattedContent, formatted) => {
    if (err) return this.emitFatal(err, message.content);
    if (formatted) message.content = formattedContent;
    this.status = preStatus;

    this._continueRunMessage(routingKey, message, messageProperties);
  });
};

proto._continueRunMessage = function continueRunMessage(routingKey, message) {
  const {
    fields,
    content: originalContent,
    ack
  } = message;
  const isRedelivered = fields.redelivered;
  const content = (0, _messageHelper.cloneContent)(originalContent);
  const {
    correlationId
  } = message.properties;
  const id = this.id;
  const step = this.environment.settings.step;
  this[stateMessageSymbol] = message;

  switch (routingKey) {
    case 'run.enter':
      {
        this.logger.debug(`<${id}> enter`, isRedelivered ? 'redelivered' : '');
        this.status = 'entered';

        if (!isRedelivered) {
          this[execSymbol].execution = null;
        }

        if (this.extensions) this.extensions.activate((0, _messageHelper.cloneMessage)(message), this);
        if (this.bpmnIo) this.bpmnIo.activate(message);
        if (!isRedelivered) this._publishEvent('enter', content, {
          correlationId
        });
        break;
      }

    case 'run.discard':
      {
        this.logger.debug(`<${id}> discard`, isRedelivered ? 'redelivered' : '');
        this.status = 'discard';
        this[execSymbol].execution = null;
        if (this.extensions) this.extensions.activate((0, _messageHelper.cloneMessage)(message), this);
        if (this.bpmnIo) this.bpmnIo.activate(message);

        if (!isRedelivered) {
          this.broker.publish('run', 'run.discarded', content, {
            correlationId
          });

          this._publishEvent('discard', content);
        }

        break;
      }

    case 'run.start':
      {
        this.logger.debug(`<${id}> start`, isRedelivered ? 'redelivered' : '');
        this.status = 'started';

        if (!isRedelivered) {
          this.broker.publish('run', 'run.execute', content, {
            correlationId
          });

          this._publishEvent('start', content, {
            correlationId
          });
        }

        break;
      }

    case 'run.execute.passthrough':
      {
        const execution = this.execution;

        if (!isRedelivered && execution) {
          this[executeMessageSymbol] = message;
          return execution.passthrough(message);
        }
      }

    case 'run.execute':
      {
        this.status = 'executing';
        this[executeMessageSymbol] = message;
        this.broker.getQueue('execution-q').assertConsumer(this[messageHandlersSymbol].onExecutionMessage, {
          exclusive: true,
          consumerTag: '_activity-execution'
        });
        const exec = this[execSymbol];
        if (!exec.execution) exec.execution = new _ActivityExecution.default(this, this.context);

        if (isRedelivered) {
          return this._resumeExtensions(message, (err, formattedContent) => {
            if (err) return this.emitFatal(err, message.content);
            if (formattedContent) message.content = formattedContent;
            this.status = 'executing';
            return exec.execution.execute(message);
          });
        }

        return exec.execution.execute(message);
      }

    case 'run.end':
      {
        if (this.status === 'end') break;
        this[countersSymbol].taken++;
        this.status = 'end';
        if (isRedelivered) break;
        return this._doRunLeave(message, false, () => {
          this._publishEvent('end', content, {
            correlationId
          });

          if (!step) ack();
        });
      }

    case 'run.error':
      {
        this._publishEvent('error', (0, _messageHelper.cloneContent)(content, {
          error: fields.redelivered ? (0, _Errors.makeErrorFromMessage)(message) : content.error
        }), {
          correlationId
        });

        break;
      }

    case 'run.discarded':
      {
        this.logger.debug(`<${content.executionId} (${id})> discarded`);
        this[countersSymbol].discarded++;
        this.status = 'discarded';
        content.outbound = undefined;

        if (!isRedelivered) {
          return this._doRunLeave(message, true, () => {
            if (!step) ack();
          });
        }

        break;
      }

    case 'run.outbound.take':
      {
        const flow = this._getOutboundSequenceFlowById(content.flow.id);

        ack();
        return flow.take(content.flow);
      }

    case 'run.outbound.discard':
      {
        const flow = this._getOutboundSequenceFlowById(content.flow.id);

        ack();
        return flow.discard(content.flow);
      }

    case 'run.leave':
      {
        this.status = undefined;
        if (this.bpmnIo) this.bpmnIo.deactivate(message);
        if (this.extensions) this.extensions.deactivate(message);

        if (!isRedelivered) {
          this.broker.publish('run', 'run.next', (0, _messageHelper.cloneContent)(content), {
            persistent: false
          });

          this._publishEvent('leave', content, {
            correlationId
          });
        }

        break;
      }

    case 'run.next':
      this._consumeInbound();

      break;
  }

  if (!step) ack();
};

proto._onExecutionMessage = function onExecutionMessage(routingKey, message) {
  const executeMessage = this[executeMessageSymbol];
  const content = (0, _messageHelper.cloneContent)({ ...executeMessage.content,
    ...message.content,
    executionId: executeMessage.content.executionId,
    parent: { ...this.parent
    }
  });
  const {
    correlationId
  } = message.properties;

  this._publishEvent(routingKey, content, message.properties);

  const broker = this.broker;

  switch (routingKey) {
    case 'execution.outbound.take':
      {
        return this._doOutbound(message, false, (err, outbound) => {
          message.ack();
          if (err) return this.emitFatal(err, content);
          broker.publish('run', 'run.execute.passthrough', (0, _messageHelper.cloneContent)(content, {
            outbound
          }));
          return this._ackRunExecuteMessage();
        });
      }

    case 'execution.error':
      {
        this.status = 'error';
        broker.publish('run', 'run.error', content, {
          correlationId
        });
        broker.publish('run', 'run.discarded', content, {
          correlationId
        });
        break;
      }

    case 'execution.discard':
      this.status = 'discarded';
      broker.publish('run', 'run.discarded', content, {
        correlationId
      });
      break;

    default:
      {
        this.status = 'executed';
        broker.publish('run', 'run.end', content, {
          correlationId
        });
      }
  }

  message.ack();

  this._ackRunExecuteMessage();
};

proto._ackRunExecuteMessage = function ackRunExecuteMessage() {
  if (this.environment.settings.step) return;
  const executeMessage = this[executeMessageSymbol];
  this[executeMessageSymbol] = null;
  executeMessage.ack();
};

proto._doRunLeave = function doRunLeave(message, isDiscarded, onOutbound) {
  const {
    content,
    properties
  } = message;
  const correlationId = properties.correlationId;

  if (content.ignoreOutbound) {
    this.broker.publish('run', 'run.leave', (0, _messageHelper.cloneContent)(content), {
      correlationId
    });
    return onOutbound();
  }

  return this._doOutbound((0, _messageHelper.cloneMessage)(message), isDiscarded, (err, outbound) => {
    if (err) {
      return this._publishEvent('error', (0, _messageHelper.cloneContent)(content, {
        error: err
      }), {
        correlationId
      });
    }

    this.broker.publish('run', 'run.leave', (0, _messageHelper.cloneContent)(content, { ...(outbound.length ? {
        outbound
      } : undefined)
    }), {
      correlationId
    });
    onOutbound();
  });
};

proto._doOutbound = function doOutbound(fromMessage, isDiscarded, callback) {
  const outboundSequenceFlows = this[flowsSymbol].outboundSequenceFlows;
  if (!outboundSequenceFlows.length) return callback(null, []);
  const fromContent = fromMessage.content;
  let discardSequence = fromContent.discardSequence;

  if (isDiscarded && !discardSequence && this[flagsSymbol].attachedTo && fromContent.inbound && fromContent.inbound[0]) {
    discardSequence = [fromContent.inbound[0].id];
  }

  let outboundFlows;

  if (isDiscarded) {
    outboundFlows = outboundSequenceFlows.map(flow => formatFlowAction(flow, {
      action: 'discard'
    }));
  } else if (fromContent.outbound && fromContent.outbound.length) {
    outboundFlows = outboundSequenceFlows.map(flow => formatFlowAction(flow, fromContent.outbound.filter(f => f.id === flow.id).pop()));
  }

  if (outboundFlows) {
    this._doRunOutbound(outboundFlows, fromContent, discardSequence);

    return callback(null, outboundFlows);
  }

  return this.evaluateOutbound(fromMessage, fromContent.outboundTakeOne, (err, evaluatedOutbound) => {
    if (err) return callback(new _Errors.ActivityError(err.message, fromMessage, err));

    const outbound = this._doRunOutbound(evaluatedOutbound, fromContent, discardSequence);

    return callback(null, outbound);
  });
};

proto._doRunOutbound = function doRunOutbound(outboundList, content, discardSequence) {
  for (const outboundFlow of outboundList) {
    const {
      id: flowId,
      action
    } = outboundFlow;
    this.broker.publish('run', 'run.outbound.' + action, (0, _messageHelper.cloneContent)(content, {
      flow: { ...outboundFlow,
        sequenceId: (0, _shared.getUniqueId)(`${flowId}_${action}`),
        ...(discardSequence ? {
          discardSequence: discardSequence.slice()
        } : undefined)
      }
    }));
  }

  return outboundList;
};

proto._onResumeMessage = function onResumeMessage(message) {
  message.ack();
  const stateMessage = this[stateMessageSymbol];
  const {
    fields
  } = stateMessage;

  switch (fields.routingKey) {
    case 'run.enter':
    case 'run.start':
    case 'run.discarded':
    case 'run.end':
    case 'run.leave':
      break;

    default:
      return;
  }

  if (!fields.redelivered) return;
  this.logger.debug(`<${this.id}> resume from ${message.content.status}`);
  return this.broker.publish('run', fields.routingKey, (0, _messageHelper.cloneContent)(stateMessage.content), stateMessage.properties);
};

proto._publishEvent = function publishEvent(state, content, messageProperties = {}) {
  if (!content) content = this._createMessage();
  this.broker.publish('event', `activity.${state}`, { ...content,
    state
  }, { ...messageProperties,
    type: state,
    mandatory: state === 'error',
    persistent: 'persistent' in messageProperties ? messageProperties.persistent : state !== 'stop'
  });
};

proto._onStop = function onStop(message) {
  const running = this[consumingSymbol];
  this.stopped = true;
  this[consumingSymbol] = false;
  const broker = this.broker;
  broker.cancel('_activity-run');
  broker.cancel('_activity-api');
  broker.cancel('_activity-execution');
  broker.cancel('_run-on-inbound');
  broker.cancel('_format-consumer');

  if (running) {
    if (this.extensions) this.extensions.deactivate(message || this._createMessage());

    this._publishEvent('stop');
  }
};

proto._consumeApi = function consumeApi() {
  const executionId = this[execSymbol].executionId;
  if (!executionId) return;
  const broker = this.broker;
  broker.cancel('_activity-api');
  broker.subscribeTmp('api', `activity.*.${executionId}`, this[messageHandlersSymbol].onApiMessage, {
    noAck: true,
    consumerTag: '_activity-api',
    priority: 100
  });
};

proto._onApiMessage = function onApiMessage(routingKey, message) {
  switch (message.properties.type) {
    case 'discard':
      {
        return this._discardRun(message);
      }

    case 'stop':
      {
        return this._onStop(message);
      }

    case 'shake':
      {
        return this._shakeOutbound(message);
      }
  }
};

proto._createMessage = function createMessage(override = {}) {
  const name = this.name,
        status = this.status,
        parent = this.parent;
  const result = { ...override,
    id: this.id,
    type: this.type,
    ...(name ? {
      name
    } : undefined),
    ...(status ? {
      status
    } : undefined),
    ...(parent ? {
      parent: (0, _messageHelper.cloneParent)(parent)
    } : undefined)
  };

  for (const [flag, value] of Object.entries(this[flagsSymbol])) {
    if (value) result[flag] = value;
  }

  return result;
};

proto._getOutboundSequenceFlowById = function getOutboundSequenceFlowById(flowId) {
  return this[flowsSymbol].outboundSequenceFlows.find(flow => flow.id === flowId);
};

proto._resumeExtensions = function resumeExtensions(message, callback) {
  const extensions = this.extensions,
        bpmnIo = this.bpmnIo;
  if (!extensions && !bpmnIo) return callback();
  if (extensions) extensions.activate((0, _messageHelper.cloneMessage)(message), this);
  if (bpmnIo) bpmnIo.activate((0, _messageHelper.cloneMessage)(message), this);
  this.status = 'formatting';
  return this.formatter(message, (err, formattedContent, formatted) => {
    if (err) return callback(err);
    return callback(null, formatted && formattedContent);
  });
};

proto._deactivateRunConsumers = function _deactivateRunConsumers() {
  const broker = this.broker;
  broker.cancel('_activity-api');
  broker.cancel('_activity-run');
  broker.cancel('_activity-execution');
  this[consumingSymbol] = false;
};

function OutboundEvaluator(activity, outboundFlows) {
  this.activity = activity;
  this.broker = activity.broker;
  const flows = this.outboundFlows = outboundFlows.slice();
  const defaultFlowIdx = flows.findIndex(({
    isDefault
  }) => isDefault);

  if (defaultFlowIdx > -1) {
    const [defaultFlow] = flows.splice(defaultFlowIdx, 1);
    flows.push(defaultFlow);
  }

  this.defaultFlowIdx = outboundFlows.findIndex(({
    isDefault
  }) => isDefault);
  this._onEvaluated = this.onEvaluated.bind(this);
  this.evaluateArgs = {};
}

OutboundEvaluator.prototype.evaluate = function evaluate(fromMessage, discardRestAtTake, callback) {
  const outboundFlows = this.outboundFlows;
  const args = this.evaluateArgs = {
    fromMessage,
    evaluationId: fromMessage.content.executionId,
    discardRestAtTake,
    callback,
    conditionMet: false,
    result: {},
    takenCount: 0
  };
  if (!outboundFlows.length) return this.completed();
  const flows = args.flows = outboundFlows.slice();
  this.broker.subscribeTmp('execution', 'evaluate.flow.#', this._onEvaluated, {
    consumerTag: `_flow-evaluation-${args.evaluationId}`
  });
  return this.evaluateFlow(flows.shift());
};

OutboundEvaluator.prototype.onEvaluated = function onEvaluated(routingKey, message) {
  const content = message.content;
  const {
    id: flowId,
    action,
    evaluationId
  } = message.content;
  const args = this.evaluateArgs;

  if (action === 'take') {
    args.takenCount++;
    args.conditionMet = true;
  }

  args.result[flowId] = content;

  if ('result' in content) {
    this.activity.logger.debug(`<${evaluationId} (${this.activity.id})> flow <${flowId}> evaluated to: ${!!content.result}`);
  }

  let nextFlow = args.flows.shift();
  if (!nextFlow) return this.completed();

  if (args.discardRestAtTake && args.conditionMet) {
    do {
      args.result[nextFlow.id] = formatFlowAction(nextFlow, {
        action: 'discard'
      });
    } while (nextFlow = args.flows.shift());

    return this.completed();
  }

  if (args.conditionMet && nextFlow.isDefault) {
    args.result[nextFlow.id] = formatFlowAction(nextFlow, {
      action: 'discard'
    });
    return this.completed();
  }

  message.ack();
  this.evaluateFlow(nextFlow);
};

OutboundEvaluator.prototype.evaluateFlow = function evaluateFlow(flow) {
  const broker = this.broker;

  if (flow.isDefault) {
    return broker.publish('execution', 'evaluate.flow.take', formatFlowAction(flow, {
      action: 'take'
    }), {
      persistent: false
    });
  }

  const flowCondition = flow.getCondition();

  if (!flowCondition) {
    return broker.publish('execution', 'evaluate.flow.take', formatFlowAction(flow, {
      action: 'take'
    }), {
      persistent: false
    });
  }

  const {
    fromMessage,
    evaluationId
  } = this.evaluateArgs;
  flowCondition.execute((0, _messageHelper.cloneMessage)(fromMessage), (err, result) => {
    if (err) return this.completed(err);
    const action = result ? 'take' : 'discard';
    return broker.publish('execution', 'evaluate.flow.' + action, formatFlowAction(flow, {
      action,
      result,
      evaluationId
    }), {
      persistent: false
    });
  });
};

OutboundEvaluator.prototype.completed = function completed(err) {
  const {
    callback,
    evaluationId,
    fromMessage,
    result,
    takenCount
  } = this.evaluateArgs;
  this.broker.cancel(`_flow-evaluation-${evaluationId}`);
  if (err) return callback(err);

  if (!takenCount && this.outboundFlows.length) {
    const nonTakenError = new _Errors.ActivityError(`<${this.activity.id}> no conditional flow taken`, fromMessage);
    return callback(nonTakenError);
  }

  const message = fromMessage.content.message;
  const evaluationResult = [];

  for (const flow of Object.values(result)) {
    evaluationResult.push({ ...flow,
      ...(message !== undefined ? {
        message
      } : undefined)
    });
  }

  return callback(null, evaluationResult);
};

function formatFlowAction(flow, options) {
  return { ...options,
    id: flow.id,
    action: options.action,
    ...(flow.isDefault ? {
      isDefault: true
    } : undefined)
  };
}