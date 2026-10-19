import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { resolveLink } from './url-utils.js';

/**
 * Turns an HTML document into inert data: metadata, readable text, headings and links.
 *
 * It parses with parse5 (a spec-compliant parser), never executes scripts, never loads
 * subresources and never renders. Script, style, template, SVG and similar content is dropped
 * entirely. The output is untrusted text: whatever the page says — including text that looks like
 * instructions — is just data here.
 */

type Node = DefaultTreeAdapterMap['node'];
type El = DefaultTreeAdapterMap['element'];

export type LinkContext = 'nav' | 'header' | 'footer' | 'main' | 'other';

export interface ExtractedLink {
  url: URL;
  text: string;
  /** The title attribute, else aria-label. */
  title: string;
  nofollow: boolean;
  context: LinkContext;
  /** Text near the link, for ranking. */
  surrounding: string;
}

export interface ExtractedPage {
  title: string;
  description: string;
  siteName: string | null;
  canonical: string | null;
  lang: string | null;
  headings: string[];
  text: string;
  links: ExtractedLink[];
  noindex: boolean;
  nofollow: boolean;
}

const MAX_TEXT_CHARS = 30_000;
const MAX_LINKS = 500;
const MAX_HEADINGS = 30;
const MIN_USEFUL_TEXT = 60;
const SURROUNDING_PIECES = 6;
const SURROUNDING_CHARS = 160;

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'embed',
  'canvas',
  'select',
  'textarea',
  'option',
  'audio',
  'video',
  'math',
]);
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'li',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'hr',
  'tr',
  'table',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'blockquote',
  'pre',
  'form',
  'fieldset',
  'figure',
  'figcaption',
  'details',
  'summary',
]);
const CELL_TAGS = new Set(['td', 'th']);

interface Piece {
  text: string;
  boilerplate: boolean;
  inMain: boolean;
}

interface Frame {
  node: Node;
  zone: LinkContext;
  boilerplate: boolean;
  inMain: boolean;
  inHead: boolean;
}

interface Exit {
  exit: El;
  startPiece: number;
  boilerplate: boolean;
  inMain: boolean;
}

interface AnchorDraft {
  href: string;
  title: string;
  nofollow: boolean;
  context: LinkContext;
  startPiece: number;
  endPiece: number;
  alt: string[];
}

function attr(el: El, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function isHidden(el: El): boolean {
  if (el.attrs.some((a) => a.name === 'hidden')) return true;
  if (attr(el, 'aria-hidden')?.trim().toLowerCase() === 'true') return true;
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(el, 'style') ?? '');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Joins pieces into lines: only block boundaries (represented as "\n") break lines. */
function toText(pieces: readonly Piece[]): string {
  return pieces
    .map((p) => p.text)
    .join('')
    .split('\n')
    .map((line) => line.replace(/ +/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

const EMPTY: ExtractedPage = {
  title: '',
  description: '',
  siteName: null,
  canonical: null,
  lang: null,
  headings: [],
  text: '',
  links: [],
  noindex: false,
  nofollow: false,
};

export function extractPage(html: string, pageUrl: URL): ExtractedPage {
  let document: Node;
  try {
    document = parse(html);
  } catch {
    return { ...EMPTY };
  }

  const pieces: Piece[] = [];
  const headings: string[] = [];
  const anchors: AnchorDraft[] = [];
  const anchorStack: AnchorDraft[] = [];
  let title = '';
  let description = '';
  let siteName: string | null = null;
  let canonicalHref: string | null = null;
  let baseHref: string | null = null;
  let lang: string | null = null;
  let robots = '';

  const stack: (Frame | Exit)[] = [
    { node: document, zone: 'other', boilerplate: false, inMain: false, inHead: false },
  ];

  const add = (text: string, frame: Pick<Frame, 'boilerplate' | 'inMain'>) =>
    pieces.push({ text, boilerplate: frame.boilerplate, inMain: frame.inMain });

  while (stack.length > 0) {
    const item = stack.pop()!;

    if ('exit' in item) {
      const el = item.exit;
      const tag = el.tagName;
      if (/^h[1-3]$/.test(tag) && headings.length < MAX_HEADINGS) {
        const text = collapse(
          pieces
            .slice(item.startPiece)
            .map((p) => p.text)
            .join(''),
        );
        if (text) headings.push(text);
      }
      if (tag === 'a') {
        const draft = anchorStack.pop();
        if (draft) draft.endPiece = pieces.length;
      }
      // Block boundaries belong to the same section as their element.
      if (BLOCK_TAGS.has(tag)) {
        pieces.push({ text: '\n', boilerplate: item.boilerplate, inMain: item.inMain });
      }
      continue;
    }

    const frame = item;
    const node = frame.node;

    if (node.nodeName === '#text') {
      if (frame.inHead) continue;
      const text = (node as DefaultTreeAdapterMap['textNode']).value.replace(/\s+/g, ' ');
      if (text !== '' && text !== ' ') add(text, frame);
      else if (text === ' ') add(' ', frame);
      continue;
    }
    if (!('tagName' in node)) {
      // Document, document fragment: descend. Comments and doctypes have no children.
      const children = 'childNodes' in node ? node.childNodes : [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ ...frame, node: children[i]! });
      }
      continue;
    }

    const el = node as El;
    const tag = el.tagName;

    if (tag === 'html') lang = attr(el, 'lang')?.trim() || null;
    if (tag === 'base' && baseHref === null) baseHref = attr(el, 'href') ?? null;
    if (tag === 'meta') {
      const name = (attr(el, 'name') ?? '').toLowerCase();
      const property = (attr(el, 'property') ?? '').toLowerCase();
      const content = attr(el, 'content') ?? '';
      if (name === 'robots') robots += ` ${content.toLowerCase()}`;
      if (name === 'description' && !description) description = collapse(content);
      if (property === 'og:site_name' && !siteName) siteName = collapse(content) || null;
    }
    if (tag === 'link' && canonicalHref === null) {
      const rel = (attr(el, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('canonical')) canonicalHref = attr(el, 'href') ?? null;
    }
    if (tag === 'title' && frame.inHead && !title) {
      title = collapse(
        el.childNodes
          .map((c) =>
            c.nodeName === '#text' ? (c as DefaultTreeAdapterMap['textNode']).value : '',
          )
          .join(''),
      );
      continue;
    }

    if (SKIP_TAGS.has(tag) || isHidden(el)) continue;

    const role = (attr(el, 'role') ?? '').toLowerCase();
    const next: Frame = { ...frame, node: el };
    if (tag === 'head') next.inHead = true;
    if (tag === 'nav' || role === 'navigation') {
      next.zone = 'nav';
      next.boilerplate = true;
    } else if (tag === 'footer' || role === 'contentinfo') {
      next.zone = 'footer';
      next.boilerplate = true;
    } else if (tag === 'header') {
      next.zone = 'header';
    } else if (tag === 'main' || role === 'main') {
      next.zone = 'main';
      next.inMain = true;
    }

    if (BLOCK_TAGS.has(tag) && !next.inHead) add('\n', next);
    if (CELL_TAGS.has(tag) && !next.inHead) add(' ', next);

    if (tag === 'img' && anchorStack.length > 0) {
      const alt = collapse(attr(el, 'alt') ?? '');
      if (alt) anchorStack[anchorStack.length - 1]!.alt.push(alt);
    }

    if (tag === 'a') {
      const href = attr(el, 'href');
      if (href !== undefined) {
        const rel = (attr(el, 'rel') ?? '').toLowerCase().split(/\s+/);
        const draft: AnchorDraft = {
          href,
          title: collapse(attr(el, 'title') || attr(el, 'aria-label') || ''),
          nofollow: rel.some((r) => r === 'nofollow' || r === 'sponsored' || r === 'ugc'),
          context: next.zone,
          startPiece: pieces.length,
          endPiece: pieces.length,
          alt: [],
        };
        anchors.push(draft);
        anchorStack.push(draft);
      } else {
        anchorStack.push({
          href: '',
          title: '',
          nofollow: false,
          context: 'other',
          startPiece: 0,
          endPiece: 0,
          alt: [],
        });
      }
    }

    stack.push({
      exit: el,
      startPiece: pieces.length,
      boilerplate: next.boilerplate,
      inMain: next.inMain,
    });
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      stack.push({ ...next, node: el.childNodes[i]! });
    }
  }

  // Resolve links against the document URL, or its <base href> when that is a valid web URL.
  let base = pageUrl;
  if (baseHref) {
    const resolved = resolveLink(baseHref, pageUrl);
    if (resolved) base = resolved;
  }
  const links: ExtractedLink[] = [];
  for (const a of anchors) {
    if (links.length >= MAX_LINKS) break;
    const url = resolveLink(a.href, base);
    if (!url) continue;
    const own = collapse(
      pieces
        .slice(a.startPiece, a.endPiece)
        .map((p) => p.text)
        .join(''),
    );
    const near = collapse(
      pieces
        .slice(Math.max(0, a.startPiece - SURROUNDING_PIECES), a.endPiece + SURROUNDING_PIECES)
        .map((p) => p.text)
        .join(''),
    ).slice(0, SURROUNDING_CHARS);
    links.push({
      url,
      text: own || a.alt.join(' '),
      title: a.title,
      nofollow: a.nofollow,
      context: a.context,
      surrounding: near,
    });
  }

  // Prefer the page's main content; fall back to everything visible when that is too thin.
  const mainText = toText(pieces.filter((p) => p.inMain && !p.boilerplate));
  const bodyText = toText(pieces.filter((p) => !p.boilerplate));
  const fullText = toText(pieces);
  const text = [mainText, bodyText].find((t) => t.length >= MIN_USEFUL_TEXT) ?? fullText;

  const canonical = canonicalHref ? (resolveLink(canonicalHref, base)?.href ?? null) : null;

  return {
    title,
    description,
    siteName,
    canonical,
    lang,
    headings,
    text: text.slice(0, MAX_TEXT_CHARS),
    links,
    noindex: /\b(noindex|none)\b/.test(robots),
    nofollow: /\b(nofollow|none)\b/.test(robots),
  };
}
