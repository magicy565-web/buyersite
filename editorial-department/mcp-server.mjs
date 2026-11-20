import { createInterface } from 'node:readline';
import { EditorialMissionRuntime } from './runtime.mjs';
import { readSeatBindings } from './seat-bindings.mjs';

const seatId = process.env.BUYERSITE_EDITORIAL_SEAT_ID;
const botId = process.env.BUYERSITE_EDITORIAL_BOT_ID;
const runtimeDir = process.env.BUYERSITE_EDITORIAL_RUNTIME_DIR;
const bindingsPath = process.env.BUYERSITE_EDITORIAL_BINDINGS_FILE;

if (!seatId || !botId || !runtimeDir || !bindingsPath) {
  process.stderr.write('BuyerSite Editorial MCP requires seat, Bot ID, runtime directory and binding file environment variables.\n');
  process.exit(2);
}

const bindings = await readSeatBindings(bindingsPath);
const binding = bindings.seats[seatId];
if (!binding || binding.botId !== botId || bindings.section !== 'BuyerSite Editorial Department') {
  process.stderr.write('BuyerSite Editorial MCP identity does not match the imported department binding.\n');
  process.exit(2);
}

const runtime = await new EditorialMissionRuntime({ dataDir: runtimeDir }).init();
const schema = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const missionId = { type: 'string', pattern: '^mission-[a-f0-9]{24}$' };
const taskId = { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' };
const taskAccessToken = { type: 'string', minLength: 32, maxLength: 128 };
const claimToken = { type: 'string', minLength: 32, maxLength: 128 };

const tools = [
  {
    name: 'buyersite_mission_get',
    description: 'Read the current mission and the context for one task assigned to this editorial seat.',
    inputSchema: schema({ missionId, taskId, taskAccessToken }, ['missionId', 'taskId', 'taskAccessToken']),
  },
  {
    name: 'buyersite_task_claim',
    description: 'Claim an assigned queued task and receive its short-lived lease token.',
    inputSchema: schema({ missionId, taskId, taskAccessToken }, ['missionId', 'taskId', 'taskAccessToken']),
  },
  {
    name: 'buyersite_task_complete',
    description: 'Submit a typed task artifact. The BuyerSite runtime validates evidence, schema and task ownership before completing it.',
    inputSchema: schema(
      { missionId, taskId, taskAccessToken, claimToken, artifact: { type: 'object' } },
      ['missionId', 'taskId', 'taskAccessToken', 'claimToken', 'artifact'],
    ),
  },
  {
    name: 'buyersite_task_fail',
    description: 'Report a real blocker for an assigned task using its active lease.',
    inputSchema: schema(
      {
        missionId,
        taskId,
        taskAccessToken,
        claimToken,
        code: { type: 'string', minLength: 1, maxLength: 80 },
        message: { type: 'string', maxLength: 500 },
      },
      ['missionId', 'taskId', 'taskAccessToken', 'claimToken', 'code', 'message'],
    ),
  },
  {
    name: 'buyersite_artifact_get',
    description: 'Read a completed dependency artifact that this seat is authorized to access.',
    inputSchema: schema(
      { missionId, artifactTaskId: taskId, currentTaskId: taskId, taskAccessToken },
      ['missionId', 'artifactTaskId', 'currentTaskId', 'taskAccessToken'],
    ),
  },
];

async function callTool(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw Object.assign(new TypeError('Tool arguments must be an object'), { code: 'INVALID_TOOL_ARGUMENTS' });
  }
  switch (name) {
    case 'buyersite_mission_get': {
      const mission = runtime.getPublicMission(args.missionId);
      const context = await runtime.getTaskContext(
        args.missionId, args.taskId, seatId, args.taskAccessToken,
      );
      return { mission, context };
    }
    case 'buyersite_task_claim':
      return runtime.claimTask({
        missionId: args.missionId,
        taskId: args.taskId,
        seatId,
        accessToken: args.taskAccessToken,
      });
    case 'buyersite_task_complete':
      return runtime.completeTask({
        missionId: args.missionId,
        taskId: args.taskId,
        seatId,
        accessToken: args.taskAccessToken,
        claimToken: args.claimToken,
        artifact: args.artifact,
      });
    case 'buyersite_task_fail':
      return runtime.failTask({
        missionId: args.missionId,
        taskId: args.taskId,
        seatId,
        accessToken: args.taskAccessToken,
        claimToken: args.claimToken,
        code: args.code,
        message: args.message,
      });
    case 'buyersite_artifact_get':
      return runtime.getArtifact(
        args.missionId, args.artifactTaskId, seatId, args.currentTaskId, args.taskAccessToken,
      );
    default:
      throw Object.assign(new Error('Unknown BuyerSite Editorial tool'), { code: 'MCP_TOOL_NOT_FOUND' });
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const id = message.id;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    const protocolVersion = ['2025-03-26', '2024-11-05'].includes(requested)
      ? requested
      : '2024-11-05';
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'buyersite-editorial-seat', version: '0.2.0' },
      },
    });
  }
  if (message.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    try {
      const result = await callTool(name, args);
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false },
      });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'BUYERSITE_TOOL_FAILED';
      const safeMessage = String(error?.code || 'Editorial tool failed').slice(0, 300);
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: code, message: safeMessage }) }],
          isError: true,
        },
      });
    }
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    continue;
  }
  await handle(message);
}
