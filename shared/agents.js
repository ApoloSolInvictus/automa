import { DEFAULT_OPENAI_MODEL } from './models.js';

// These IDs make the template's four example cards immediately testable. A
// saved Firestore document with the same ID automatically overrides its data.
export const DEFAULT_AGENTS = Object.freeze({
  'support-bot-v2-1': {
    name: 'Customer Support Agent',
    description: 'Customer Support',
    model: 'gpt-5.6-terra',
    status: 'enabled',
    instructions: 'Resolve customer support questions clearly. Ask for the minimum information needed, explain the next safe step, and escalate billing, refunds, security or account access issues to a human.'
  },
  'sales-qualifier': {
    name: 'Contract Coordinator',
    description: 'Client & Contract Flow',
    model: 'gpt-5.6-sol',
    status: 'enabled',
    instructions: 'Coordinate client and contract intake by identifying the request, urgency, required documents, decision process and missing details. Return a concise summary and the next follow-up question. Never invent facts or approve a contract.'
  },
  'data-analyzer': {
    name: 'Business Flow Analyst',
    description: 'Business Analytics',
    model: 'gpt-5.6-luna',
    status: 'enabled',
    instructions: 'Analyze the business data included in the user message. State assumptions, highlight trends and anomalies, and return concise actionable findings. Do not claim to have accessed data that was not provided.'
  },
  'email-automator': {
    name: 'Follow-up Agent',
    description: 'Customer Follow-up',
    model: DEFAULT_OPENAI_MODEL,
    status: 'enabled',
    instructions: 'Draft clear, professional business emails from the supplied context. Include a subject and body, respect the requested tone, and ask for review before any message is sent.'
  }
});

export const getDefaultAgent = id => DEFAULT_AGENTS[id] ? { id, ...DEFAULT_AGENTS[id] } : null;
