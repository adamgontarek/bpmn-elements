import Environment from '../../src/Environment';
import factory from '../helpers/factory';
import testHelpers from '../helpers/testHelpers';
import {ActivityError} from '../../src/error/Errors';
import {Definition} from '../../src/definition/Definition';
import {format} from 'util';
import {Scripts as JavaScripts} from '../helpers/JavaScripts';

const lanesSource = factory.resource('lanes.bpmn');

describe('Definition', () => {
  describe('requirements', () => {
    it('requires a context with id and environment', () => {
      const definition = Definition({
        id: 'Def_1',
        environment: Environment(),
      });
      expect(definition.run).to.be.a('function');
    });

    it('requires context with getProcesses() and getExecutableProcesses() to run', () => {
      const definition = Definition({
        id: 'Def_1',
        environment: Environment({ Logger: testHelpers.Logger }),
        getProcesses() {},
        getExecutableProcesses() {},
      });
      definition.run();
      expect(definition.counters).to.have.property('completed', 1);
    });

    it('inherits environment from context', () => {
      const Logger = testHelpers.Logger;
      const services = {
        myService: () => {},
      };
      const definition = Definition({
        id: 'Def_1',
        environment: Environment({ Logger, services }),
        getProcesses() {},
        getExecutableProcesses() {},
        getMessageFlows() {},
      });
      definition.run();
      expect(definition.environment.Logger === Logger).to.be.true;
      expect(definition.environment.getServiceByName('myService')).to.equal(services.myService);
    });

    it('throws if without arguments', () => {
      expect(() => {
        Definition();
      }).to.throw(/No context/);
    });

    it('takes environment override options as second argument', () => {
      const scripts = JavaScripts();
      const environment = Environment({ Logger: testHelpers.Logger, scripts });
      const definition = Definition({
        id: 'Def_1',
        environment,
        getProcesses() {},
        getExecutableProcesses() {},
        clone(newEnvironment) {
          return {
            environment: newEnvironment,
          };
        },
      }, {
        services: {
          myService() {},
        },
        variables: {
          input: 1,
        },
      });

      expect(definition.environment.variables).to.eql({input: 1});
      expect(definition.environment.services).to.have.property('myService').that.is.a('function');
      expect(definition.environment.scripts).to.equal(scripts);
      expect(definition.environment.Logger).to.equal(environment.Logger);
    });
  });

  describe('run()', () => {
    it('publishes enter on run', async () => {
      const definition = Definition({
        id: 'Def_1',
        environment: Environment({ Logger: testHelpers.Logger }),
        getProcesses() {},
        getExecutableProcesses() {},
        getMessageFlows() {},
        getDataObjects() {},
      });
      const enter = definition.waitFor('enter');

      definition.run();

      await enter;
    });

    it('publishes start when started', async () => {
      const definition = Definition({
        id: 'Def_1',
        environment: Environment({ Logger: testHelpers.Logger }),
        getProcesses() {},
        getExecutableProcesses() {},
        getMessageFlows() {},
      });

      const start = definition.waitFor('start');

      definition.run();

      await start;
    });

    it('publishes end when all processes are completed', async () => {
      const context = await testHelpers.context(lanesSource);

      const definition = Definition(context);
      const processes = definition.getProcesses();
      expect(processes).to.have.length(2);

      const end = definition.waitFor('end');

      definition.run();

      await end;

      expect(processes[0].counters, processes[0].id).to.have.property('completed', 1);
      expect(processes[1].counters, processes[1].id).to.have.property('completed', 1);
    });

    it('passes environment to processes', async () => {
      const services = {
        myService: () => {},
      };
      const context = await testHelpers.context(lanesSource, {
        Logger: testHelpers.Logger,
        services,
      });

      const definition = Definition(context);
      const processes = definition.getProcesses();
      expect(processes).to.have.length(2);

      expect(processes[0].environment.Logger).to.equal(testHelpers.Logger);
      expect(processes[0].environment.services).to.equal(services);
      expect(processes[1].environment.Logger).to.equal(testHelpers.Logger);
      expect(processes[1].environment.services).to.equal(services);
    });

    it('publishes leave when all processes are completed', async () => {
      const context = await testHelpers.context(lanesSource);

      const definition = Definition(context);
      const processes = definition.getProcesses();
      expect(processes).to.have.length(2);

      const leave = definition.waitFor('leave');

      definition.run();

      await leave;

      expect(processes[0].counters, processes[0].id).to.have.property('completed', 1);
      expect(processes[1].counters, processes[1].id).to.have.property('completed', 1);
    });

    it('leaves no messages in run queue when completed', async () => {
      const context = await testHelpers.context(lanesSource);

      const definition = Definition(context);
      const processes = definition.getProcesses();
      expect(processes).to.have.length(2);

      const leave = definition.waitFor('leave');

      definition.run();

      await leave;

      expect(definition.broker.getQueue('run-q')).to.have.property('messageCount', 0);
    });

    it('leaves no messages in run queue when completed with callback', async () => {
      const context = await testHelpers.context(lanesSource);

      const definition = Definition(context);
      const processes = definition.getProcesses();
      expect(processes).to.have.length(2);

      const leave = definition.waitFor('leave');

      let messageCount;
      definition.run(() => {
        messageCount = definition.broker.getQueue('run-q').messageCount;
      });

      await leave;

      expect(messageCount).to.equal(0);
    });

    it('calls optional callback when completed', (done) => {
      testHelpers.context(factory.valid(), {}, (_, moddleContext) => {
        const def = Definition(moddleContext, {scripts: JavaScripts()});
        def.run((err) => {
          if (err) return done(err);
          done();
        });
      });
    });

    it('calls second callback when ran and completed again', (done) => {
      testHelpers.context(factory.valid(), {}, (_, moddleContext) => {
        const def = Definition(moddleContext, {scripts: JavaScripts()});
        def.run((errRun1) => {
          if (errRun1) return done(errRun1);

          def.run((errRun2) => {
            if (errRun2) return done(errRun2);
            done();
          });
        });
      });
    });

    it('returns error in callback if no executable process', (done) => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="false" />
      </definitions>`;

      testHelpers.context(source, (merr, result) => {
        if (merr) return done(merr);

        const def = Definition(result);
        def.run((err) => {
          expect(err).to.be.an('error').with.property('message', 'No executable process');
          done();
        });
      });
    });

    it('throws error if no executable process', async () => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="false" />
      </definitions>`;

      const context = await testHelpers.context(source);
      const def = Definition(context);

      expect(def.run).to.throw('No executable process');
    });

    it('emits error if no executable process', async () => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="false" />
      </definitions>`;

      const context = await testHelpers.context(source);
      const def = Definition(context);

      let error;
      def.once('error', (err) => {
        error = err;
      });

      def.run();
      expect(error).to.be.an('error').with.property('message', 'No executable process');
    });

    it('emits error on activity error', async () => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions id="Definition_1" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <serviceTask id="task" implementation="\${environment.services.shaky}" />
        </process>
      </definitions>`;
      const context = await testHelpers.context(source);
      context.environment.addService('shaky', (_, next) => {
        next(Error('unstable'));
      });

      const definition = Definition(context);

      let error;
      definition.on('error', (err) => {
        expect(err).to.be.instanceof(ActivityError);
        expect(err.message).to.equal('unstable');
        error = err;
      });

      definition.run();

      expect(error).to.be.ok;
    });

    it('throws error on activity error', async () => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <serviceTask id="task" implementation="\${environment.services.shaky}" />
        </process>
      </definitions>`;
      const context = await testHelpers.context(source);
      context.environment.addService('shaky', (_, next) => {
        next(Error('unstable'));
      });

      const def = Definition(context);

      expect(def.run).to.throw(/unstable/);
    });
  });

  describe('getActivityById()', () => {
    let context;
    before(async () => {
      context = await testHelpers.context(lanesSource);
    });

    it('returns child activity', () => {
      const definition = Definition(context);
      expect(definition.getActivityById('task1')).to.exist;
    });

    it('returns child activity from participant process', () => {
      const definition = Definition(context);
      expect(definition.getActivityById('completeTask')).to.exist;
    });

    it('returns null if activity is not found', () => {
      const definition = Definition(context);
      expect(definition.getActivityById('whoAmITask')).to.be.null;
    });
  });

  describe('getPostponed()', () => {
    let context;
    beforeEach(async () => {
      const source = `
      <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <startEvent id="start" />
          <sequenceFlow id="flow1" sourceRef="start" targetRef="task1" />
          <sequenceFlow id="flow2" sourceRef="start" targetRef="task2" />
          <sequenceFlow id="flow3" sourceRef="start" targetRef="subProcess" />
          <userTask id="task1" />
          <userTask id="task2" />
          <subProcess id="subProcess">
            <userTask id="task3" />
          </subProcess>
          <sequenceFlow id="flow4" sourceRef="task1" targetRef="end" />
          <sequenceFlow id="flow5" sourceRef="task2" targetRef="end" />
          <sequenceFlow id="flow6" sourceRef="subProcess" targetRef="end" />
          <endEvent id="end" />
        </process>
      </definitions>`;

      context = await testHelpers.context(source);
    });

    it('returns none if not executing', () => {
      const def = Definition(context);
      expect(def.getPostponed()).to.have.length(0);
    });

    it('returns executing activities', () => {
      const def = Definition(context);
      def.run();

      const activities = def.getPostponed();
      expect(activities).to.have.length(3);
      expect(activities[0].id).to.equal('task1');
      expect(activities[1].id).to.equal('task2');
      expect(activities[2].id).to.equal('subProcess');
    });
  });

  describe('getApi()', () => {
    let context;
    before(async () => {
      const source = `
      <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <startEvent id="start" />
          <sequenceFlow id="flow1" sourceRef="start" targetRef="task1" />
          <sequenceFlow id="flow2" sourceRef="start" targetRef="task2" />
          <sequenceFlow id="flow3" sourceRef="start" targetRef="subProcess" />
          <userTask id="task1" />
          <userTask id="task2" />
          <subProcess id="subProcess">
            <userTask id="task3" />
          </subProcess>
          <sequenceFlow id="flow4" sourceRef="task1" targetRef="end" />
          <sequenceFlow id="flow5" sourceRef="task2" targetRef="end" />
          <sequenceFlow id="flow6" sourceRef="subProcess" targetRef="end" />
          <endEvent id="end" />
        </process>
      </definitions>`;

      context = await testHelpers.context(source);
    });

    it('returns api on each event', () => {
      const definition = Definition(context.clone());
      definition.broker.subscribeTmp('event', '#', (routingKey, message) => {
        const api = definition.getApi(message);
        expect(api, message.content.id).to.be.ok;
        expect(message.content.type).to.equal(api.content.type);
      }, {noAck: true});

      definition.run();
    });

    it('returns undefined if message parent is not definition execution', () => {
      const definition = Definition(context.clone());

      let api = false;
      definition.broker.subscribeOnce('event', 'activity.#', (routingKey, message) => {
        message.content.parent.id = 'fake-id';
        api = definition.getApi(message);
      }, {noAck: true});

      definition.run();

      expect(api).to.be.undefined;
    });

    it('returns undefined if message parent path is not resolved', () => {
      const definition = Definition(context.clone());

      let api = false;
      definition.broker.subscribeTmp('event', 'activity.#', (routingKey, message) => {
        if (message.content.id === 'task3') {
          message.content.parent.path = [];
          api = definition.getApi(message);
        }
      }, {noAck: true});

      definition.run();

      expect(api).to.be.undefined;
    });
  });

  describe('getState()', () => {
    const source = factory.userTask(undefined, 'stateDef');
    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('returns state when not running', () => {
      const definition = Definition(context);

      const state = definition.getState();

      expect(state.status).to.equal('pending');
      expect(state).to.have.property('broker').that.is.ok;
      expect(state.execution).to.be.undefined;
    });

    it('returns context, broker, and execution when running', () => {
      const definition = Definition(context);
      definition.run();

      const state = definition.getState();

      expect(state.status).to.equal('executing');
      expect(state.stopped).to.be.undefined;
      expect(state).to.have.property('broker').that.is.ok;
      expect(state).to.have.property('execution').that.is.ok;
      expect(state).to.have.property('counters');
      expect(state.execution).to.have.property('processes').with.length(1);
    });

    it('returns context, broker, and execution when stopped', () => {
      const definition = Definition(context);
      definition.run();
      definition.stop();

      const state = definition.getState();

      expect(state.status).to.equal('executing');
      expect(state).to.have.property('broker').that.is.ok;
      expect(state).to.have.property('execution').that.is.ok;
      expect(state.execution).to.have.property('stopped', true);
      expect(state).to.have.property('counters');
      expect(state.execution).to.have.property('processes').with.length(1);
    });
  });

  describe('stop()', () => {
    const source = factory.userTask(undefined, 'stopDef');
    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('ignored if not executing', () => {
      const definition = Definition(context);
      definition.stop();
      expect(definition.getState().stopped).to.be.undefined;
    });

    it('stops running processes', () => {
      const definition = Definition(context);
      definition.run();
      definition.stop();
      expect(definition.stopped).to.equal(true);
      expect(definition.execution.stopped).to.equal(true);

      const processes = definition.getProcesses();
      expect(processes).to.have.length(1);
      expect(processes[0]).to.have.property('stopped', true);
    });

    it('stops run queue and leaves run message', () => {
      const definition = Definition(context);
      definition.run();
      definition.stop();
      expect(definition.stopped).to.equal(true);

      const runQ = definition.broker.getQueue('run-q');
      expect(runQ).to.have.property('consumerCount', 0);
      expect(runQ).to.have.property('messageCount', 1);
      expect(runQ.peek(true)).to.have.property('fields').that.have.property('routingKey', 'run.execute');
    });
  });

  describe('recover()', () => {
    const source = factory.userTask(undefined, 'recoverDef');
    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('recovers without state', () => {
      const definition = Definition(context);

      definition.run();
      definition.stop();

      definition.recover();
    });

    it('recovers with state', () => {
      const definition1 = Definition(context);

      definition1.run();
      definition1.stop();

      const definition2 = Definition(context.clone()).recover(definition1.getState());
      expect(definition2).to.have.property('status', 'executing');
    });
  });

  describe('resume()', () => {
    const source = factory.userTask('userTask', 'def_1');
    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('resumes execution if stopped', () => {
      const definition = Definition(context);
      definition.run();
      definition.stop();

      expect(definition.getPostponed()[0].id).to.equal('userTask');

      definition.resume();
      expect(definition).to.have.property('status', 'executing');
      expect(definition.counters).to.have.property('completed', 0);

      const [activity] = definition.getPostponed();
      expect(activity.id).to.equal('userTask');

      activity.signal();

      expect(definition.counters).to.have.property('completed', 1);
    });

    it('resumes after recovered with state', () => {
      const startDefinition = Definition(context);
      startDefinition.run();
      startDefinition.stop();

      const definition = Definition(context.clone()).recover(startDefinition.getState());

      definition.resume();

      const [activity] = definition.getPostponed();
      expect(activity.id).to.equal('userTask');
      expect(definition.counters).to.have.property('completed', 0);

      activity.signal();

      expect(definition.counters).to.have.property('completed', 1);
    });

    it('resumes after recovered with running state', () => {
      const startDefinition = Definition(context);
      startDefinition.run();
      const state = startDefinition.getState();

      const definition = Definition(context.clone()).recover(state);
      definition.resume();

      const [activity] = definition.getPostponed();
      expect(activity.id).to.equal('userTask');
      expect(definition.counters).to.have.property('completed', 0);
      activity.signal();
      expect(definition.counters).to.have.property('completed', 1);
    });
  });

  describe('getProcesses()', () => {
    let definition;
    before('Given definition is initiated with two processes', async () => {
      const context = await testHelpers.context(lanesSource);
      definition = Definition(context);
    });

    it('returns processes from passed moddle context', () => {
      expect(definition.getProcesses().length).to.equal(2);
    });
  });

  describe('errors', () => {
    it('throws error if no-one is listening for errors', async () => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <serviceTask id="task" implementation="\${environment.services.shaky}" />
        </process>
      </definitions>`;

      const context = await testHelpers.context(source);
      context.environment.addService('shaky', (_, next) => {
        next(Error('unstable'));
      });
      const definition = Definition(context);

      expect(definition.run).to.throw('unstable');
    });

    it('emits error on activity error', async () => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <serviceTask id="task" implementation="\${environment.services.shaky}" />
        </process>
      </definitions>`;

      const context = await testHelpers.context(source);
      context.environment.addService('shaky', (_, next) => {
        next(Error('unstable'));
      });
      const definition = Definition(context);

      const errors = [];
      definition.on('error', (err) => {
        errors.push(err);
      });

      definition.run();

      expect(errors).to.have.length(1);
      expect(errors[0]).to.be.instanceof(ActivityError);
      expect(errors[0].message).to.equal('unstable');
    });

    it('emits error on flow error', async () => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <startEvent id="theStart" />
          <exclusiveGateway id="decision" />
          <endEvent id="end1" />
          <endEvent id="end2" />
          <sequenceFlow id="flow1" sourceRef="theStart" targetRef="decision" />
          <sequenceFlow id="flow2" sourceRef="decision" targetRef="end1">
            <conditionExpression xsi:type="tFormalExpression" language="PowerShell"><![CDATA[
            ls | clip
            ]]></conditionExpression>
          </sequenceFlow>
          <sequenceFlow id="flow3" sourceRef="decision" targetRef="end2">
            <conditionExpression xsi:type="tFormalExpression" language="PowerShell"><![CDATA[
            ls | clip
            ]]></conditionExpression>
          </sequenceFlow>
        </process>
      </definitions>`;

      const context = await testHelpers.context(source);
      const bp = context.getProcessById('theProcess');

      let error;
      bp.once('error', (err) => {
        expect(err).to.be.instanceof(Error);
        expect(err.message).to.match(/is unsupported/);
        error = err;
      });

      bp.run();

      expect(error).to.be.ok;
    });

    describe('child error', () => {
      it('throws', async () => {
        const source = `
        <?xml version="1.0" encoding="UTF-8"?>
        <definitions id="testError" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <process id="theProcess" isExecutable="true">
            <serviceTask id="serviceTask" name="Get" implementation="\${environment.services.shaky}" />
          </process>
        </definitions>`;

        const context = await testHelpers.context(source);
        context.environment.addService('shaky', (_, next) => {
          next(Error('unstable'));
        });

        const definition = Definition(context);

        expect(definition.run).to.throw('unstable');
      });

      it('error event handler catches error', async () => {
        const source = `
        <?xml version="1.0" encoding="UTF-8"?>
        <definitions id="testError" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <process id="theProcess" isExecutable="true">
            <serviceTask id="serviceTask" name="Get" implementation="\${environment.services.none}" />
          </process>
        </definitions>`;

        const context = await testHelpers.context(source);
        const definition = Definition(context);

        let error;
        definition.once('error', (childErr) => {
          error = childErr;
        });

        definition.run();

        expect(error).to.be.instanceof(ActivityError).and.match(/did not resolve to a function/i);
      });
    });
  });

  describe('Logger', () => {
    it('passes Logger onto children', async () => {
      const log = {};

      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
      <definitions id="testError" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <task id="task">
            <multiInstanceLoopCharacteristics isSequential="true">
              <loopCardinality>3</loopCardinality>
            </multiInstanceLoopCharacteristics>
          </task>
        </process>
      </definitions>`;

      const context = await testHelpers.context(source, {Logger});
      const definition = Definition(context);

      definition.run();

      expect(Object.keys(log)).to.have.same.members([
        'bpmn:definitions',
        'bpmn:process',
        'bpmn:task',
        'bpmn:multiinstanceloopcharacteristics'
      ]);

      function Logger(scope) {
        return {
          debug,
        };

        function debug(...args) {
          const msgs = log[scope] = [];
          msgs.push(format(scope, ...args));
        }
      }
    });
  });

  describe('waitFor()', () => {
    it('returns promise that resolves when event occur', async () => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
      <definitions id="testError" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <task id="task" />
        </process>
      </definitions>`;

      const context = await testHelpers.context(source);
      const definition = Definition(context);

      const leave = definition.waitFor('leave');

      definition.run();

      return leave;
    });

    it('rejects if execution error is published', (done) => {
      const source = `
      <?xml version="1.0" encoding="UTF-8"?>
      <definitions id="testError" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <userTask id="task" />
        </process>
      </definitions>`;

      testHelpers.context(source).then((context) => {
        const definition = Definition(context);

        definition.once('wait', () => {
          definition.broker.publish('execution', 'execution.error', {error: new Error('unstable')}, {mandatory: true, type: 'error'});
        });

        definition.waitFor('leave').catch((err) => {
          expect(err.message).to.equal('unstable');
          done();
        });

        definition.run();
      });
    });
  });
});