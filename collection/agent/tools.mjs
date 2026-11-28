import { KnowledgeError } from './contracts.mjs';

const entity = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id', 'label'],
  properties: {
    type: { enum: ['company', 'product'] },
    id: { type: 'string' },
    label: { type: 'string' },
  },
};
const input = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

// Atomic tools for the existing Agent/MCP host. Human review is intentionally a
// separate authenticated host action, so extraction cannot approve its own facts.
export function createCollectionTools(agent) {
  const definitions = [
    {
      name: 'enterprise_knowledge_list_sources',
      description: 'List available internal enterprise library documents.',
      inputSchema: input({}),
    },
    {
      name: 'enterprise_knowledge_ingest',
      description:
        'Read a fixed library document version, extract candidate facts and return targeted follow-up questions.',
      inputSchema: input(
        { documentId: { type: 'string' }, version: { type: 'integer', minimum: 1 }, entity },
        ['documentId', 'entity'],
      ),
    },
    {
      name: 'enterprise_knowledge_analyze',
      description:
        'Retry extraction for an already imported source, using confirmed entity memory.',
      inputSchema: input(
        {
          source_id: { type: 'string' },
          revision: { type: 'string' },
          entity,
          reparse: { type: 'boolean' },
        },
        ['source_id', 'revision', 'entity'],
      ),
    },
    {
      name: 'enterprise_knowledge_read',
      description:
        'Read entity knowledge, source evidence, confirmation state and scoped learning memory.',
      inputSchema: input({ entity }),
    },
    {
      name: 'enterprise_knowledge_questions',
      description:
        'Return the next missing, conflicting or unconfirmed information questions and requested materials.',
      inputSchema: input({ entity, limit: { type: 'integer', minimum: 1, maximum: 10 } }, [
        'entity',
      ]),
    },
  ];
  const handlers = {
    enterprise_knowledge_list_sources: () => agent.listLibraryDocuments(),
    enterprise_knowledge_ingest: (args) => agent.ingestLibraryDocument(args),
    enterprise_knowledge_analyze: (args) => agent.analyzeSource(args),
    enterprise_knowledge_read: (args) => agent.getKnowledge(args),
    enterprise_knowledge_questions: (args) => agent.getNextQuestions(args),
  };
  return {
    definitions,
    async call(name, args = {}) {
      const definition = definitions.find((item) => item.name === name);
      if (
        !definition ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key))
      ) {
        throw new KnowledgeError('INVALID_TOOL_CALL', 'Unknown tool or unsupported arguments');
      }
      return handlers[name](args);
    },
  };
}
