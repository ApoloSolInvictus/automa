import { DEFAULT_OPENAI_MODEL } from './models.js';

// These IDs make the template's four example cards immediately testable. A
// saved Firestore document with the same ID automatically overrides its data.
export const DEFAULT_AGENTS = Object.freeze({
  'support-bot-v2-1': {
    name: 'Support Bot v2.1',
    description: 'Customer Support',
    model: 'gpt-5.6-terra',
    status: 'enabled',
    instructions: 'Resolve customer support questions clearly. Ask for the minimum information needed, explain the next safe step, and escalate billing, refunds, security or account access issues to a human.'
  },
  'sales-qualifier': {
    name: 'Sales Qualifier',
    description: 'Sales Automation',
    model: 'gpt-5.6-sol',
    status: 'enabled',
    instructions: 'Qualify business leads by identifying their goal, urgency, budget and decision process. Return a concise qualification summary and the next follow-up question. Never invent facts.'
  },
  'data-analyzer': {
    name: 'Data Analyzer',
    description: 'Analytics',
    model: 'gpt-5.6-luna',
    status: 'enabled',
    instructions: 'Analyze the business data included in the user message. State assumptions, highlight trends and anomalies, and return concise actionable findings. Do not claim to have accessed data that was not provided.'
  },
  'email-automator': {
    name: 'Email Automator',
    description: 'Email Marketing',
    model: DEFAULT_OPENAI_MODEL,
    status: 'enabled',
    instructions: 'Draft clear, professional business emails from the supplied context. Include a subject and body, respect the requested tone, and ask for review before any message is sent.'
  }
});

export const getDefaultAgent = id => DEFAULT_AGENTS[id] ? { id, ...DEFAULT_AGENTS[id] } : null;
