interface UpdateEvidence {
  from?: string;
  to?: string;
  depType?: string;
  depTypeFrom?: string;
  resolutions?: string[];
  resolutionsFrom?: string[];
}

/** Explain equal-version updates without implying a version upgrade. */
export function describeUpdate(event: UpdateEvidence): string {
  const moved = event.depTypeFrom && event.depTypeFrom !== event.depType;
  let text: string;
  if (event.from === undefined && event.to === undefined) {
    text = 'dependency changed; version details unavailable';
  } else if (event.resolutionsFrom) {
    text = `resolved versions {${event.resolutionsFrom.join(', ')}} -> {${(event.resolutions || [event.to || '?']).join(', ')}}`;
  } else if (event.from === event.to) {
    text = `${event.to || '?'} (version unchanged)${moved ? '' : '; dependency metadata changed'}`;
  } else {
    text = `${event.from || '?'} -> ${event.to || '?'}`;
  }
  if (moved) text += `; section: ${event.depTypeFrom} -> ${event.depType}`;
  return text;
}
