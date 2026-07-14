const PROVIDER_PREFIX_TO_STRIP = 'custom-llmapi-redteamstuff-com/';
const DEFAULT_BARE_MODEL = 'claude-sonnet-5';

const LLMAPI_BARE_MODELS = [
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gpt-5.3-codex',
  'gpt-5.5-pro',
  'gpt-5.5',
  'qwen3.6-27b-fp8',
  'qwen3.6-35b-a3b-fp8',
  'minimax-m2.7',
  'gemma-4-31b-it-fp8',
];

function bareModelAlias(value, { fallback = DEFAULT_BARE_MODEL } = {}) {
  let model = String(value || '').trim();
  if (!model) return fallback;
  if (model.startsWith(PROVIDER_PREFIX_TO_STRIP)) model = model.slice(PROVIDER_PREFIX_TO_STRIP.length);
  return model.trim() || fallback;
}

function isBareModelAlias(value) {
  const model = String(value || '');
  return model.trim() === model && model.length > 0 && !model.includes('/');
}

module.exports = {
  PROVIDER_PREFIX_TO_STRIP,
  DEFAULT_BARE_MODEL,
  LLMAPI_BARE_MODELS,
  bareModelAlias,
  isBareModelAlias,
};
