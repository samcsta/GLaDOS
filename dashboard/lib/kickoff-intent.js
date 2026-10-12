function normalizedIntent(message) {
  return String(message || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

function isKickoffApproval(message) {
  return /\b(continue|proceed|go ahead|approved?|yes|start|do it|looks good)\b/i.test(String(message || ''));
}

function isKickoffCancel(message) {
  const text = normalizedIntent(message);
  return /^(?:please )?(?:cancel|stop|halt)(?: (?:this|the))?(?: (?:kickoff|investigation|assessment|run|request|process))?$/.test(text)
    || /^(?:please )?(?:no|never mind|nevermind|do not proceed)$/.test(text);
}

function isNetReconRequested(message) {
  const text = normalizedIntent(message);
  const mentionsNetRecon = /\b(?:net(?:work)?|infrastructure)\s*(?:-| )?(?:recon|reconnaissance|scan|scanning|assessment)\b/.test(text)
    || /\bnet-recon\b/.test(text);
  if (!mentionsNetRecon) return false;
  return !/\b(?:no|skip|without|exclude|do not|don't)\b.{0,40}\b(?:net(?:work)?|infrastructure|net-recon)\b/.test(text);
}

const CLIPPY_RESOURCE = { id: 'clippy', label: 'Clippy MCP', url: 'https://clippy.redteamstuff.com:8443/mcp/' };
const LEGACY_RESOURCES = [
  { id: 'dradistab', label: 'Dradis Tab', url: 'https://dradistab.redteamstuff.com' },
  { id: 'dradis', label: 'Dradis', url: 'https://dradis.redteamstuff.com' },
  { id: 'domainsai', label: 'DomainsAI', url: 'https://domainsai.redteamstuff.com' },
];

function resolveKickoffResources(message, { clippyAvailable = false } = {}) {
  const text = String(message || '').toLowerCase();
  const skipClippy = /\b(?:skip|omit|exclude|without|do not use|don't use)\b[^.?!;\n]*\bclippy\b/.test(text);
  let resources = clippyAvailable && !skipClippy ? [CLIPPY_RESOURCE] : [...LEGACY_RESOURCES];
  if (clippyAvailable && skipClippy) {
    const requested = text.match(/\b(?:use|include|consult|check|continue with|proceed with)\b[^.?!;\n]*/)?.[0] || '';
    if (/\b(?:dradistab|dradis|domainsai|domains\s*ai)\b/.test(requested)) {
      resources = LEGACY_RESOURCES.filter(resource => resource.id === 'dradistab'
        ? /\bdradistab\b|\bdradis\s+tab\b/.test(requested)
        : resource.id === 'domainsai' ? /\bdomainsai\b|\bdomains\s*ai\b/.test(requested)
          : /\bdradis\b/.test(requested));
    }
  }

  // Legacy sources are opt-in when Clippy is present; they remain the default
  // for installations without a configured Clippy credential.
  if (clippyAvailable && !skipClippy && /\b(?:use|include|also check|check|consult|with|only)\b[^.?!;\n]*\b(?:dradistab|dradis|domainsai|domains\s*ai)\b/.test(text)) {
    for (const resource of LEGACY_RESOURCES) {
      const named = resource.id === 'dradistab' ? /\bdradistab\b|\bdradis\s+tab\b/.test(text)
        : resource.id === 'domainsai' ? /\bdomainsai\b|\bdomains\s*ai\b/.test(text)
          : /\bdradis\b/.test(text);
      if (named) resources.push(resource);
    }
  }

  const only = text.match(/\bonly\s+(clippy|domainsai|domains\s*ai|dradistab|dradis)\b/);
  if (only) {
    const id = only[1].replace(/\s+/g, '');
    resources = [CLIPPY_RESOURCE, ...LEGACY_RESOURCES].filter(resource => resource.id === id && (id !== 'clippy' || clippyAvailable));
  }

  if (/\b(?:proceed|go|run)\s+blind\b|\bskip\s+(?:all\s+)?(?:internal\s+)?(?:resource|resources|lookups|checks)\b/.test(text)) {
    resources = [];
  } else {
    // Treat every comma/"and" separated resource in a negative clause as
    // skipped. The previous immediate-token checks misread phrases such as
    // "skip DradisTab, Dradis, DomainsAI" and approved the latter two.
    const negativeClauses = [...text.matchAll(/\b(?:skip|omit|exclude|without|do not use|don't use)\b[^.?!;\n]*/g)]
      .map(match => match[0].split(/\b(?:and\s+)?(?:use|include|consult|check|continue with|proceed with)\b/)[0]);
    const skipped = new Set();
    for (const clause of negativeClauses) {
      if (/\bclippy\b/.test(clause)) skipped.add('clippy');
      if (/\bdradistab\b|\bdradis\s+tab\b/.test(clause)) skipped.add('dradistab');
      if (/\bdradis\b/.test(clause)) skipped.add('dradis');
      if (/\bdomainsai\b|\bdomains\s*ai\b/.test(clause)) skipped.add('domainsai');
    }

    // "Dradis checks" historically means both Dradis surfaces.
    if (/\bskip\s+(?:the\s+)?dradis(?:tab)?\s+checks?\b/.test(text)) {
      skipped.add('dradis');
      skipped.add('dradistab');
    }
    resources = resources.filter(resource => !skipped.has(resource.id));
  }

  const first = text.match(/\b(clippy|domainsai|dradistab|dradis)\s+first\b/);
  if (first) {
    resources.sort((a, b) => (a.id === first[1] ? -1 : b.id === first[1] ? 1 : 0));
  }

  return resources;
}

module.exports = {
  isKickoffApproval,
  isKickoffCancel,
  isNetReconRequested,
  resolveKickoffResources,
};
