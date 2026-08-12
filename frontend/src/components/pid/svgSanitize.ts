/**
 * Defense-in-depth SVG scrubbing for custom P&ID symbols.
 * Symbols are rendered via dangerouslySetInnerHTML; strip active content,
 * embeds, and SMIL/event vectors before import or paint.
 */

/** Strip active / embeddable content from an SVG root element in-place. */
export function scrubSvgElement(root: Element): void {
  root
    .querySelectorAll(
      "script, foreignObject, iframe, style, use, image, set, animate, animateTransform, animateMotion, a"
    )
    .forEach((element) => element.remove());
  root.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.toLowerCase();
      const isHref = name === "href" || name === "xlink:href";
      const smilEvent = name === "attributename" && value.trimStart().startsWith("on");
      if (name.startsWith("on") || smilEvent || (isHref && !value.startsWith("#"))) {
        element.removeAttribute(attribute.name);
      }
    }
  });
}

/** Sanitize SVG inner markup before rendering (defense in depth for stored symbols). */
export function sanitizeSvgInner(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${trimmed}</svg>`,
    "image/svg+xml"
  );
  if (doc.querySelector("parsererror")) return "";
  const svg = doc.querySelector("svg");
  if (!svg) return "";
  scrubSvgElement(svg);
  return svg.innerHTML.trim();
}
