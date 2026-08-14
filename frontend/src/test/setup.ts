import "@testing-library/jest-dom/vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;

/** Minimal DOMMatrix polyfill so React Flow can read viewport zoom in jsdom. */
class DOMMatrixReadOnlyMock {
  m22 = 1;

  constructor(transform?: string) {
    if (transform && transform !== "none") {
      const matrix = transform.match(/matrix\(([^)]+)\)/);
      if (matrix) {
        const values = matrix[1].split(",").map((part) => Number.parseFloat(part.trim()));
        if (values.length >= 4 && Number.isFinite(values[3])) {
          this.m22 = values[3];
        }
      }
    }
  }
}

if (!globalThis.DOMMatrixReadOnly) {
  globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyMock as typeof DOMMatrixReadOnly;
}
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = DOMMatrixReadOnlyMock as typeof DOMMatrix;
}
