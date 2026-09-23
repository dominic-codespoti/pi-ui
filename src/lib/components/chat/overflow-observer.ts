const updates = new Map<Element, () => void>();
let intersectionObserver: IntersectionObserver | undefined;
let resizeObserver: ResizeObserver | undefined;

function getIntersectionObserver() {
  intersectionObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const update = updates.get(entry.target);
      if (!update) continue;
      intersectionObserver?.unobserve(entry.target);
      resizeObserver ??= new ResizeObserver((observedEntries) => {
        for (const observedEntry of observedEntries) {
          updates.get(observedEntry.target)?.();
        }
      });
      resizeObserver.observe(entry.target);
      update();
    }
  });
  return intersectionObserver;
}

export function observeOverflow(node: Element, update: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') {
    update();
    return () => {};
  }

  updates.set(node, update);
  getIntersectionObserver().observe(node);
  return () => {
    updates.delete(node);
    intersectionObserver?.unobserve(node);
    resizeObserver?.unobserve(node);
  };
}
