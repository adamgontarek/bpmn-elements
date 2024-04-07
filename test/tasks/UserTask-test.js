import testHelpers from '../helpers/testHelpers.js';

describe('UserTask', () => {
  describe('execution', () => {
    const source = `
    <?xml version="1.0" encoding="UTF-8"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <process id="theProcess" isExecutable="true">
        <startEvent id="start" />
        <userTask id="task" />
        <endEvent id="end" />
        <sequenceFlow id="flow1" sourceRef="start" targetRef="task" />
        <sequenceFlow id="flow2" sourceRef="task" targetRef="end" />
      </process>
    </definitions>`;

    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('keeps execute wait state until signaled', async () => {
      const task = context.getActivityById('task');

      const waiting = task.waitFor('wait');
      const left = task.waitFor('leave');
      task.activate();
      task.run();

      const taskApi = await waiting;

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(1);
      expect(task.broker.getQueue('execute-q').messageCount, 'execute queue').to.equal(1);

      taskApi.signal();

      await left;

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(0);
      expect(task.broker.getQueue('execute-q').messageCount, 'execute queue').to.equal(0);
    });

    it('sets output when signaled', async () => {
      const task = context.getActivityById('task');

      const waiting = task.waitFor('wait');
      const left = task.waitFor('leave');
      task.activate();
      task.run();

      const taskApi = await waiting;
      taskApi.signal({ data: 1 });

      const api = await left;

      expect(api.content.output).to.eql({ data: 1 });
    });

    it('can be errored out via an error message', async () => {
      const task = context.getActivityById('task');

      const waiting = task.waitFor('wait');
      const error = task.waitFor('error');
      task.activate();
      task.run();

      const taskApi = await waiting;
      taskApi.sendApiMessage('error', { message: 'a user error occurred' });

      const api = await error;

      expect(api.content.error.message).to.eql('a user error occurred');
    });

    it('runs through if discarded', async () => {
      const task = context.getActivityById('task');

      const left = task.waitFor('leave');
      task.activate();
      task.inbound[0].discard();

      await left;

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(0);
      expect(task.broker.getQueue('execute-q'), 'execute queue').to.not.be.ok;
    });

    it('state on wait has postponed start message', async () => {
      const task = context.getActivityById('task');

      const wait = task.waitFor('wait');
      task.run();

      await wait;

      const executeQ = task.broker.getQueue('execute-q');
      const runQ = task.broker.getQueue('run-q');
      expect(runQ.messageCount, 'run queue').to.equal(1);
      expect(executeQ.messageCount, 'execute queue').to.equal(1);

      expect(runQ.peek().fields).to.have.property('routingKey', 'run.execute');
      expect(executeQ.peek().fields).to.have.property('routingKey', 'execute.start');
    });

    it('state on leave depletes all messages', async () => {
      const task = context.getActivityById('task');

      const wait = task.waitFor('wait');
      const leave = task.waitFor('leave');
      task.run();

      (await wait).signal();

      await leave;

      const runQ = task.broker.getQueue('run-q');
      const executeQ = task.broker.getQueue('execute-q');
      const executionQ = task.broker.getQueue('execution-q');

      expect(runQ.messageCount, 'run queue').to.equal(0);
      expect(executeQ.messageCount, 'execute queue').to.equal(0);
      expect(executionQ.messageCount, 'execution queue').to.equal(0);
    });

    it('stop and resume continues execution', async () => {
      const task = context.getActivityById('task');

      const wait = task.waitFor('wait');
      task.run();

      const stop = task.waitFor('stop');
      await wait;

      task.stop();

      await stop;

      const executeQ = task.broker.getQueue('execute-q');
      expect(executeQ.consumerCount).to.equal(0);
      expect(executeQ.peek().fields).to.have.property('routingKey', 'execute.start');

      const leave = task.waitFor('leave');
      task.resume();

      (await wait).signal();

      return leave;
    });
  });

  describe('sequential loop execution', () => {
    const source = `
    <?xml version="1.0" encoding="UTF-8"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <process id="theProcess" isExecutable="true">
        <startEvent id="start" />
        <userTask id="task">
          <multiInstanceLoopCharacteristics isSequential="true">
            <loopCardinality>3</loopCardinality>
          </multiInstanceLoopCharacteristics>
        </userTask>
        <endEvent id="end" />
        <sequenceFlow id="flow1" sourceRef="start" targetRef="task" />
        <sequenceFlow id="flow2" sourceRef="task" targetRef="end" />
      </process>
    </definitions>`;

    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('keeps execute wait state until signaled', async () => {
      const task = context.getActivityById('task');

      let waiting = task.waitFor('wait');
      const leave = task.waitFor('leave');
      task.activate();
      task.run();

      let taskApi = await waiting;

      const executeQ = task.broker.getQueue('execute-q');

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(1);
      expect(executeQ.messageCount, 'execute queue').to.equal(2);

      waiting = task.waitFor('wait');
      taskApi.signal({ iteration: 0 });

      taskApi = await waiting;

      expect(executeQ.messageCount, 'execute queue').to.equal(2);

      waiting = task.waitFor('wait');
      taskApi.signal({ iteration: 1 });

      taskApi = await waiting;

      expect(executeQ.messageCount, 'execute queue').to.equal(2);

      waiting = task.waitFor('wait');
      taskApi.signal({ iteration: 2 });

      const left = await leave;
      expect(left.content.output).to.eql([{ iteration: 0 }, { iteration: 1 }, { iteration: 2 }]);

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(0);
      expect(executeQ.messageCount, 'execute queue').to.equal(0);

      expect(task.broker.getQueue('iteration-q'), 'iteration queue').to.not.be.ok;
    });

    it('runs through if discarded', async () => {
      const task = context.getActivityById('task');

      const left = task.waitFor('leave');
      task.activate();
      task.inbound[0].discard();

      await left;

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(0);
      expect(task.broker.getQueue('execute-q'), 'execute queue').to.not.be.ok;
    });

    it('resumes from last completed', async () => {
      const task = context.getActivityById('task');

      task.once('wait', (api) => {
        api.signal(api.content.index);
        task.stop();
      });

      task.run();

      const leave = task.waitFor('leave');

      const waitConsumer = task.on('wait', (api) => {
        api.signal(api.content.index);
      });

      task.resume();

      const left = await leave;

      waitConsumer.cancel();

      expect(left.content.output).to.eql([0, 1, 2]);
    });

    it('resumes stopped recovered from last completed', async () => {
      const task = context.getActivityById('task');

      task.once('wait', (api) => {
        api.signal(api.content.index);
      });

      task.run();

      task.stop();

      const recoveredTask = context.clone().getActivityById('task');
      const leave = recoveredTask.waitFor('leave');

      const waitConsumer = recoveredTask.on('wait', (api) => {
        api.signal(api.content.index);
      });

      const state = task.getState();

      recoveredTask.recover(state);
      recoveredTask.resume();

      const left = await leave;
      waitConsumer.cancel();
      expect(left.content.output).to.eql([0, 1, 2]);
    });

    it('resumes recovered running state from last completed', async () => {
      const task = context.getActivityById('task');

      task.once('wait', (api) => {
        api.signal(api.content.index);
      });

      task.run();

      const recoveredTask = context.clone().getActivityById('task');
      const leave = recoveredTask.waitFor('leave');

      const waitConsumer = recoveredTask.on('wait', (api) => {
        api.signal(api.content.index);
      });

      const state = task.getState();

      recoveredTask.recover(state);
      recoveredTask.resume();

      const left = await leave;
      waitConsumer.cancel();
      expect(left.content.output).to.eql([0, 1, 2]);
    });

    it('resumes recovered stopped while signaled from last completed', async () => {
      const task = context.getActivityById('task');

      task.on('wait', (api) => {
        api.signal(api.content.index);
        if (api.content.index === 1) task.stop();
      });

      task.run();

      const recoveredTask = context.clone().getActivityById('task');
      const leave = recoveredTask.waitFor('leave');

      const waitConsumer = recoveredTask.on('wait', (api) => {
        api.signal(api.content.index);
      });

      const state = task.getState();

      recoveredTask.recover(state);
      recoveredTask.resume();

      const left = await leave;
      waitConsumer.cancel();
      expect(left.content.output).to.eql([0, 1, 2]);
    });
  });

  describe('parallel loop execution', () => {
    const source = `
    <?xml version="1.0" encoding="UTF-8"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <process id="theProcess" isExecutable="true">
        <startEvent id="start" />
        <userTask id="task">
          <multiInstanceLoopCharacteristics isSequential="false">
            <loopCardinality>3</loopCardinality>
          </multiInstanceLoopCharacteristics>
        </userTask>
        <endEvent id="end" />
        <sequenceFlow id="flow1" sourceRef="start" targetRef="task" />
        <sequenceFlow id="flow2" sourceRef="task" targetRef="end" />
      </process>
    </definitions>`;

    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('keeps execute wait state until signaled', async () => {
      const task = context.getActivityById('task');

      let waiting = task.waitFor('wait');
      const left = task.waitFor('leave');
      task.activate();
      task.run();

      await waiting;

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(1);
      expect(task.broker.getQueue('execute-q').messageCount, 'execute queue').to.be.above(1);

      waiting = task.waitFor('wait');

      const childExecutions = task.getApi().getExecuting();
      expect(childExecutions.length).to.equal(3);

      childExecutions[2].signal({ iteration: 2 });
      childExecutions[0].signal({ iteration: 0 });
      childExecutions[1].signal({ iteration: 1 });

      await left;

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(0);
      expect(task.broker.getQueue('execute-q').messageCount, 'execute queue').to.equal(0);
    });

    it('stop in the middle of parallel loop keeps start messages', async () => {
      const task = context.getActivityById('task');
      const stop = task.waitFor('stop', (_, msg) => msg.content.id === task.id);

      task.once('wait', (api) => {
        api.signal();
        task.stop();
      });

      task.run();

      await stop;

      const executeQ = task.broker.getQueue('execute-q');

      expect(executeQ).to.have.property('messageCount', 5);

      const messages = executeQ.messages.slice();

      let message;

      message = messages.shift();
      expect(message.fields).to.have.property('routingKey', 'execute.iteration.batch');
      expect(message.fields).to.have.property('redelivered', true);
      expect(message.content).to.have.property('isRootScope', true);

      message = messages.shift();
      expect(message.fields).to.have.property('routingKey', 'execute.start');
      expect(message.fields).to.have.property('redelivered', true);
      expect(message.content.isRootScope).to.not.be.ok;
      expect(message.content).to.have.property('index', 0);

      message = messages.shift();
      expect(message.fields).to.have.property('routingKey', 'execute.start');
      expect(message.fields.redelivered).to.not.be.ok;
      expect(message.content.isRootScope).to.not.be.ok;
      expect(message.content).to.have.property('index', 1);

      message = messages.shift();
      expect(message.fields).to.have.property('routingKey', 'execute.start');
      expect(message.fields.redelivered).to.not.be.ok;
      expect(message.content.isRootScope).to.not.be.ok;
      expect(message.content).to.have.property('index', 2);

      message = messages.shift();
      expect(message.fields).to.have.property('routingKey', 'execute.completed');
      expect(message.fields.redelivered).to.not.be.ok;
      expect(message.content.isRootScope).to.not.be.ok;
      expect(message.content).to.have.property('index', 0);
    });

    it('runs through if discarded', async () => {
      const task = context.getActivityById('task');

      const left = task.waitFor('leave');
      task.activate();
      task.inbound[0].discard();

      await left;

      expect(task.broker.getQueue('run-q').messageCount, 'run queue').to.equal(0);
      expect(task.broker.getQueue('execute-q'), 'execute queue').to.not.be.ok;
    });

    it('resumes from last completed', async () => {
      const task = context.getActivityById('task');

      task.once('wait', (api) => {
        api.signal(api.content.index);
        task.stop();
      });

      task.run();

      const leave = task.waitFor('leave', (_, __, owner) => {
        if (owner === task) return true;
      });

      const waitConsumer = task.on('wait', (api) => {
        api.signal(api.content.index);
      });

      task.resume();

      const left = await leave;
      waitConsumer.cancel();

      expect(left.content.output).to.eql([0, 1, 2]);
    });

    it('resumes recovered', async () => {
      let task = context.getActivityById('task');

      task.once('wait', (api) => {
        api.signal(api.content.index);
        task.stop();
      });

      task.run();

      expect(task).to.have.property('stopped', true);
      const state = task.getState();

      task = context.clone().getActivityById('task');
      task.recover(state);

      const leave = task.waitFor('leave', (_, __, owner) => {
        if (owner === task) return true;
      });

      const waitConsumer = task.on('wait', (api) => {
        api.signal(api.content.index);
      });

      task.resume();

      const left = await leave;
      waitConsumer.cancel();

      expect(left.content.output).to.eql([0, 1, 2]);
    });
  });
});
