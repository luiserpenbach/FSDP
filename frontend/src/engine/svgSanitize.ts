/**
 * SVG scrubbing for user-defined symbols. Symbol markup is stored on the
 * server and painted with dangerouslySetInnerHTML (library panel, canvas,
 * legacy diagrams), so everything but plain drawing elements is removed:
 * scripts, embeds, links, styles, animation (SMIL can set event attributes),
 * HTML elements, comments and CDATA (which re-parse as markup inside
 * <title>/<desc> once the serialised SVG goes through the HTML parser), event
 * attributes, and external or script URLs.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Drawing elements a symbol may contain (lower-cased local names). */
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "line",
  "polyline",
  "polygon",
  "rect",
  "circle",
  "ellipse",
  "text",
  "tspan",
  "defs",
  "marker",
  "clippath",
  "mask",
  "pattern",
  "lineargradient",
  "radialgradient",
  "stop"
]);

/** Script-capable URL schemes and CSS expressions, after spaces and control characters are dropped. */
const SCRIPT_VALUE = /(?:javascript|vbscript|data):|expression\(/i;
/** CSS/presentation url() references that leave the document. */
const EXTERNAL_URL = /url\(\s*['"]?\s*(?!#)/i;

function unsafeAttribute(attribute: Attr): boolean {
  const name = attribute.localName.toLowerCase();
  const value = attribute.value;
  const compact = [...value].filter((char) => char.charCodeAt(0) > 0x20).join("");
  if (name.startsWith("on")) return true;
  if (name === "href") return !value.trim().startsWith("#");
  if (name === "attributename" && compact.toLowerCase().startsWith("on")) return true;
  return SCRIPT_VALUE.test(compact) || EXTERNAL_URL.test(value);
}

function allowedElement(element: Element): boolean {
  const namespace = element.namespaceURI;
  return (namespace === SVG_NS || namespace === null) && ALLOWED_ELEMENTS.has(element.localName.toLowerCase());
}

function scrubAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    if (unsafeAttribute(attribute)) element.removeAttributeNode(attribute);
  }
}

/** Drop comments and processing instructions; turn CDATA into plain text. */
function scrubNodes(parent: Node): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      parent.removeChild(node);
    } else if (node.nodeType === Node.CDATA_SECTION_NODE) {
      const text = node.ownerDocument?.createTextNode(node.textContent ?? "");
      if (text) parent.replaceChild(text, node);
      else parent.removeChild(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      scrubNodes(node);
    }
  }
}

/** Strip active / embeddable content from an SVG root element in place (the root itself is kept). */
export function scrubSvgElement(root: Element): void {
  for (const element of [...root.querySelectorAll("*")]) {
    if (!allowedElement(element)) element.remove();
  }
  scrubAttributes(root);
  root.querySelectorAll("*").forEach(scrubAttributes);
  scrubNodes(root);
}

/**
 * Sanitize SVG inner markup before rendering. Returns "" for markup that
 * does not parse, or when no DOM parser is available (fails closed).
 */
export function sanitizeSvgInner(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${trimmed}</svg>`, "image/svg+xml");
  if (doc.querySelector("parsererror")) return "";
  const svg = doc.documentElement;
  if (!svg || svg.localName !== "svg") return "";
  scrubSvgElement(svg);
  return svg.innerHTML.trim();
}
