const PROVIDER_PREFIX_TO_STRIP = 'custom-llmapi-redteamstuff-com/';
const DEFAULT_BARE_MODEL = 'claude-sonnet-5';

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
  bareModelAlias,
  isBareModelAlias,
};
