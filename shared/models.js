/**
 * OpenAI models exposed by the agent editor.
 * Keep this list deliberately small so a browser cannot select a provider or
 * model that the server has not approved.
 */
export const OPENAI_MODELS = Object.freeze([
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Most capable option for complex work.' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'High quality general business work.' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced quality, speed and cost.' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Fast, cost-sensitive, high-volume work.' }
]);

// Existing deployments may still use these OpenAI-only aliases. They remain
// accepted for the global Vercel fallback while new agents use the catalog.
export const LEGACY_OPENAI_MODEL_IDS = Object.freeze(['gpt-5-mini', 'gpt-4o', 'gpt-4o-mini']);
export const OPENAI_MODEL_IDS = Object.freeze([
  ...OPENAI_MODELS.map(model => model.id),
  ...LEGACY_OPENAI_MODEL_IDS
]);
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';
export const isAllowedOpenAIModel = value => typeof value === 'string' && OPENAI_MODEL_IDS.includes(value.trim());
export const modelLabel = value => OPENAI_MODELS.find(model => model.id === value)?.label || value || 'OpenAI';
