// Normalize the admitted Hermes/agent-browser accessibility tree for the
// existing broker. Preserve hierarchy and attributes used for action review.
export function normalizedHermesSnapshot(snapshot) {
  return snapshot.split('\n').map(line => {
    const match = line.match(/^(\s*)- (.*?) \[([^\]]*\bref=(e\d+)\b[^\]]*)\](.*)$/);
    return match ? `${match[1]}@${match[4]} ${match[2]} [${match[3]}]${match[5]}` : line;
  }).join('\n');
}

export function observedFixtureRef(text, label) {
  // StaticText can carry the same label as a control but has no reference.
  // Ambiguous controls must be disambiguated by the test, never first-match.
  const matches = text.split('\n').flatMap(line => {
    const match = line.match(/^\s*(@e\d+)\s+\w+\s+"([^"]*)"/);
    return match && match[2] === label ? [match[1]] : [];
  });
  if (matches.length !== 1) throw new Error(`Expected one referenced control named ${label}, found ${matches.length}`);
  return matches[0];
}
