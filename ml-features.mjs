export function transform(observations, attempts, pseudonym) {
  const rows = [];
  const counts = { incomplete: 0, invalid: 0 };
  function provenance(...emails) {
    return emails.some(e => e.endsWith('@neura.example')) ? 'local_demo' : 'local_unverified';
  }
  function add(id, source, instrument, features, assessment = null) {
    rows.push({ participant: pseudonym(id), assessment: assessment && pseudonym(assessment),
      source, instrument, features, diagnosis: null });
  }
  const inRange = (x, max) => Number.isInteger(x) && x >= 0 && x <= max;
  for (const obs of observations) {
    const v = obs.payload?.value;
    if (!v?.completedAt) { counts.incomplete++; continue; }
    const source = provenance(obs.users.email, obs.participants.users.email);
    if (obs.instrument_key === 'questionnaire') {
      const answers = Array.from({ length: 10 }, (_, i) => v.answers?.[i]);
      if (!answers.every(x => inRange(x, 4))) { counts.invalid++; continue; }
      add(obs.participant_id, source, 'workspace-questionnaire-v1',
        Object.fromEntries(answers.map((x,i) => ['q'+i, x === 4 ? null : x])));
    } else {
      const a = v.answers;
      if (v.mode !== 'party' || !Array.isArray(a) || a.length !== 8 || !a.every((x,i) =>
        x?.situationId === i && (i === 7 ? [0,1,2,4].includes(x.choice) : inRange(x.choice, 3))
        && (i !== 3 || inRange(x.emotionChoice, 3))
        && ['seconds','changes','help'].every(k => inRange(x[k], Number.MAX_SAFE_INTEGER)))) {
        counts.invalid++; continue;
      }
      const features = Object.fromEntries(a.map((x,i) => ['choice'+i, x.choice]));
      features.emotion3 = a[3].emotionChoice;
      for (const k of ['seconds','changes','help']) features[k] = a.reduce((n,x) => n+x[k], 0);
      add(obs.participant_id, source, 'workspace-party-v1', features);
    }
  }
  for (const attempt of attempts) {
    if (!attempt.completed_at) { counts.incomplete++; continue; }
    const { assessments: a, kind, version } = attempt.assignments;
    if (version !== '1' || !['game','questionnaire'].includes(kind) || attempt.answers.length !== 3 || !attempt.answers.every(x => inRange(x, 2))) {
      counts.invalid++; continue;
    }
    add(a.child_id, provenance(a.users.email, a.participants.users.email), 'family-'+kind+'-v1',
      Object.fromEntries(attempt.answers.map((x,i) => ['step'+i, x])), a.id);
  }
  rows.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return { rows, counts };
}
