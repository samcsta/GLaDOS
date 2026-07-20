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

function resolveKickoffResources(message) {
  const text = String(message || '').toLowerCase();
  let resources = [
    { id: 'dradistab', label: 'Dradis Tab', url: 'https://dradistab.redteamstuff.com' },
    { id: 'dradis', label: 'Dradis', url: 'https://dradis.redteamstuff.com' },
    { id: 'domainsai', label: 'DomainsAI', url: 'https://domainsai.redteamstuff.com' },
  ];

  if (/\bonly\s+domainsai\b/.test(text)) {
    resources = resources.filter(resource => resource.id === 'domainsai');
  }

  if (/\bskip\s+(?:all\s+)?(?:internal\s+)?(?:resource|resources|lookups|checks)\b/.test(text)) {
    resources = [];
  } else {
    // Treat every comma/"and" separated resource in a negative clause as
    // skipped. The previous immediate-token checks misread phrases such as
    // "skip DradisTab, Dradis, DomainsAI" and approved the latter two.
    const negativeClauses = [...text.matchAll(/\b(?:skip|omit|exclude|without|do not use|don't use)\b[^.?!;\n]*/g)]
      .map(match => match[0]);
    const skipped = new Set();
    for (const clause of negativeClauses) {
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

  if (/\bdomainsai\s+first\b/.test(text)) {
    resources.sort((a, b) => (a.id === 'domainsai' ? -1 : b.id === 'domainsai' ? 1 : 0));
  }

  return resources;
}

module.exports = {
  isKickoffApproval,
  isKickoffCancel,
  isNetReconRequested,
  resolveKickoffResources,
};
