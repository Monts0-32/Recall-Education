// ============================================================================
// lesson-render.js — Shared block renderer + interactivity for the student
// lesson player (lesson.html) and the staff creator's preview pane.
//
// Loaded as a global script by both:
//   - lesson.html  (student side)
//   - staff.html   (creator's preview modal + inline preview)
//
// Everything is hung off a single global namespace `LessonRender` to avoid
// polluting `window` with a wall of helpers. The staff page already
// references `BLOCK_DEFS` directly (legacy), so we ALSO export
// `window.BLOCK_DEFS` and `window.bindInteractive` for backward
// compatibility — see the bottom of the file.
//
// Block model: each block is { id, kind, data, order_index }. The 25
// supported kinds are listed in the CHECK on public.lesson_blocks.
// ============================================================================

(function () {
  'use strict';

  // ---------- shared helpers -----------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normText(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // numericSynonyms(s) — turn digit and word forms of small numbers into
  // a canonical (digit) form. Used by compareBlank() so that an answer
  // of 'one' and a student input of '1' (or vice versa) match. We
  // always normalise to the digit form so the comparison is symmetric:
  //   numericSynonyms('one')  === '1'
  //   numericSynonyms('1')    === '1'
  //   numericSynonyms('two')  === '2'
  // Bounded to 0–10 — extending past 10 is a one-line table edit.
  const WORD_NUM = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
  function numericSynonyms(s) {
    let out = ' ' + String(s || '').toLowerCase() + ' ';
    // word → digit first, then digit stays as digit (no second pass needed).
    out = out.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => WORD_NUM[w] || w);
    return out.trim();
  }

  // compareBlank(got, want) — true if `got` matches `want` leniently.
  // Three rules, in order:
  //   1. exact match after normText (case + whitespace tolerant)
  //   2. synonym match via numericSynonyms (1 ↔ one, 2 ↔ two, …, 10 ↔ ten)
  //   3. 70% prefix fill: when want has >= 4 chars and got is shorter
  //      than want, the first ceil(0.7 * len(want)) characters of want
  //      must match `got` exactly. Returns true in that case so the
  //      Check handler can auto-complete the rest of the word.
  // The 70% rule only fires for shorter inputs — typing more than the
  // answer (e.g. an extra letter) falls through to strict equality.
  function compareBlank(got, want) {
    const a = normText(got);
    const b = normText(want);
    if (!a) return false;
    if (a === b) return true;
    if (numericSynonyms(a) === numericSynonyms(b)) return true;
    if (b.length >= 4 && a.length < b.length) {
      const need = Math.ceil(b.length * 0.7);
      if (a.length >= need && b.startsWith(a)) return true;
    }
    return false;
  }

  // prefixFillEligible(got, want) — returns the canonical completion
  // string when `got` has reached the 70% prefix threshold of `want`,
  // or null when it's not eligible. Used for real-time auto-fill as
  // the student types (so the rest of the answer drops in the moment
  // they've typed enough) and on Check (to complete a still-short
  // input that already counts as correct).
  //
  // Mirrors the prefix rule in compareBlank so both the live-typing
  // and Check-time paths agree on what "70%" means. `got` is the
  // raw input value (we compare on normText, so trailing spaces and
  // case differences don't break the match); `want` is the answer.
  // Returns the answer (case-folded to match the student's casing of
  // the typed prefix) when eligible, otherwise null.
  function prefixFillEligible(got, want) {
    const a = normText(got);
    const b = normText(want);
    if (!a) return null;
    if (b.length < 4) return null;       // threshold only meaningful on longer words
    if (a.length >= b.length) return null; // already at/past the answer
    const need = Math.ceil(b.length * 0.7);
    if (a.length < need) return null;
    if (!b.startsWith(a)) return null;
    // Preserve the student's casing of the typed prefix; copy the
    // rest verbatim from the answer. e.g. student types "pho" +
    // want "photosynthesis" → "pho" + "tosynthesis" = "photosynthesis".
    // If the student typed "Pho" we get "Pho" + "tosynthesis" =
    // "Phot osynthesis" — preserve the typed case exactly.
    return got + b.slice(a.length);
  }

  // Lightweight Markdown: fences, headings, lists, blockquote, inline
  // bold/italic/code/links. Input is escaped first so any user-supplied
  // HTML is rendered as text. Good enough for educational content; not
  // a general-purpose parser.
  function renderMarkdown(md) {
    if (!md) return '';
    let s = escapeHtml(md);
    s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`);
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    s = s.replace(/(^|\n)((?:- .+(?:\n|$))+)/g, (_, pre, list) => {
      const items = list.trim().split('\n').map(l => l.replace(/^- /, '')).map(l => `<li>${l}</li>`).join('');
      return pre + '<ul>' + items + '</ul>';
    });
    s = s.replace(/(^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, pre, list) => {
      const items = list.trim().split('\n').map(l => l.replace(/^\d+\. /, '')).map(l => `<li>${l}</li>`).join('');
      return pre + '<ol>' + items + '</ol>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.split(/\n{2,}/).map(p => {
      p = p.trim();
      if (!p) return '';
      if (/^<(h\d|ul|ol|pre|blockquote|img|figure)/.test(p)) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');
    return s;
  }

  function videoEmbedUrl(url, provider) {
    if (!url) return '';
    if (provider === 'youtube') {
      let id = '';
      const m1 = url.match(/youtu\.be\/([\w-]{6,})/);
      if (m1) id = m1[1];
      const m2 = url.match(/[?&]v=([\w-]{6,})/);
      if (!id && m2) id = m2[1];
      const m3 = url.match(/embed\/([\w-]{6,})/);
      if (!id && m3) id = m3[1];
      if (!id) return '';
      return `https://www.youtube.com/embed/${id}`;
    }
    if (provider === 'vimeo') {
      const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      if (!m) return '';
      return `https://player.vimeo.com/video/${m[1]}`;
    }
    return '';
  }

  function practiceWrap(content) {
    return `<div class="practice">${content}</div>`;
  }

  // ---------- practice renderers -------------------------------------------
  // Each function returns the static HTML for an interactive block. Event
  // listeners are attached by bindInteractive() once the HTML is in the
  // DOM.

  function renderMCQ(b) {
    const d = b.data;
    const opts = d.options || [];
    const isMulti = !!d.multi;
    const inputType = isMulti ? 'checkbox' : 'radio';
    return practiceWrap(`
      <div class="prompt">${escapeHtml(d.prompt || '')}</div>
      <div class="options" data-pbid="mcq-opts">
        ${opts.map((o, i) => `
          <button type="button" class="opt" data-idx="${i}">
            <input type="${inputType}" disabled style="pointer-events:none;margin-top:2px;accent-color:var(--blue);" />
            <span>${escapeHtml(o.text || '')}</span>
          </button>
        `).join('')}
      </div>
      <div class="check-row">
        <button type="button" class="check-btn" data-pb="check">Check</button>
        <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  function renderTrueFalse(b) {
    const d = b.data;
    return practiceWrap(`
      <div class="prompt">${escapeHtml(d.prompt || '')}</div>
      <div class="options" data-pbid="tf-opts">
        <button type="button" class="opt" data-idx="t">✓ True</button>
        <button type="button" class="opt" data-idx="f">✗ False</button>
      </div>
      <div class="check-row">
        <button type="button" class="check-btn" data-pb="check">Check</button>
        <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  function renderShortAnswer(b) {
    const d = b.data;
    return practiceWrap(`
      <div class="prompt">${escapeHtml(d.prompt || '')}</div>
      <div class="check-row">
        <input type="text" class="sa-input" data-pbid="sa-input" placeholder="Type your answer…" style="flex:1;" />
        <button type="button" class="check-btn" data-pb="check">Check</button>
        <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  function renderFillBlank(b) {
    const d = b.data;
    const text = d.text || '';
    const blanks = d.blanks || [];
    const parts = text.split('___');
    let html = '<div class="fb-sentence">';
    parts.forEach((part, i) => {
      html += escapeHtml(part);
      if (i < blanks.length) {
        const len = Math.max(8, (blanks[i].answer || '').length + 2);
        html += `<input type="text" class="fb-input" data-fb="${i}" style="width:${Math.min(220, len * 8)}px;" />`;
      }
    });
    html += '</div>';
    return practiceWrap(`
      <div class="prompt">Fill in the blanks:</div>
      ${html}
      <div class="check-row">
        <button type="button" class="check-btn" data-pb="check">Check</button>
        <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  function renderMatch(b) {
    const d = b.data;
    const pairs = d.pairs || [];
    if (!pairs.length) return practiceWrap(`<div class="prompt">No pairs to match.</div>`);
    // Shuffle the right column deterministically by index parity.
    const rights = pairs.map((p, i) => ({ text: p.right, origIndex: i }));
    for (let i = rights.length - 1; i > 0; i--) {
      const j = (i * 7 + 3) % (i + 1);
      [rights[i], rights[j]] = [rights[j], rights[i]];
    }
    return practiceWrap(`
      <div class="prompt">${escapeHtml(d.prompt || 'Match the pairs.')}</div>
      <div class="match-grid">
        <div class="match-col">
          <h5>Items</h5>
          ${pairs.map((p, i) => `<button type="button" class="match-tile" data-side="L" data-idx="${i}">${escapeHtml(p.left)}</button>`).join('')}
        </div>
        <div class="match-col">
          <h5>Matches</h5>
          ${rights.map(r => `<button type="button" class="match-tile" data-side="R" data-idx="${r.origIndex}">${escapeHtml(r.text)}</button>`).join('')}
        </div>
      </div>
      <div class="check-row">
        <button type="button" class="check-btn" data-pb="check">Check</button>
        <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  function renderOrdering(b) {
    const d = b.data;
    const items = d.items || [];
    if (!items.length) return practiceWrap(`<div class="prompt">No items to order.</div>`);
    // Shuffle the order. Use a stable shuffle that gives a different
    // result each call so the student sees a different starting order.
    const shuffled = items.map(x => x);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return practiceWrap(`
      <div class="prompt">${escapeHtml(d.prompt || 'Put these in the correct order.')}</div>
      <div class="order-list" data-pbid="order-list">
        ${shuffled.map(it => `<div class="order-item" draggable="true" data-id="${escapeHtml(it.id)}"><span class="grip">⋮⋮</span><span>${escapeHtml(it.text)}</span></div>`).join('')}
      </div>
      <div class="check-row">
        <button type="button" class="check-btn" data-pb="check">Check</button>
        <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  function renderHotspot(b) {
    const d = b.data;
    if (!d.imageUrl) return practiceWrap(`<div class="prompt">[Hotspot: add an image URL in the editor]</div>`);
    const hs = d.hotspots || [];
    return practiceWrap(`
      <div class="prompt">Click on the correct area of the image.</div>
      <div class="hotspot-wrap" data-pbid="hs-wrap">
        <img src="${escapeHtml(d.imageUrl)}" alt="${escapeHtml(d.alt || '')}" />
        ${hs.map((h, i) => `<div class="dot" data-hs="${i}" style="left:${h.x}%;top:${h.y}%;display:none;">${i + 1}</div>`).join('')}
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  // renderDenaryBinary(b) — show a denary number; student toggles bits
  // (MSB on the left) to build the binary answer. Correctness is derived
  // from the stored denary value, so there's no per-student state to
  // persist — every Check computes the expected string from d.denary and
  // compares to the live bit state. bitWidth controls how many bits are
  // shown (1–16); the editor clamps denary to fit.
  function renderDenaryBinary(b) {
    const d = b.data || {};
    const bitWidth = clampBitWidth(d.bitWidth);
    const denary = clampDenary(d.denary, bitWidth);
    // Bit place values, MSB first. For 8 bits: 128, 64, 32, 16, 8, 4, 2, 1.
    const placeValues = [];
    for (let i = bitWidth - 1; i >= 0; i--) placeValues.push(Math.pow(2, i));
    return practiceWrap(`
      <div class="prompt">${escapeHtml(d.prompt || 'Convert the following denary number to binary.')}</div>
      <div class="db-denary">
        <span class="db-denary-label">Denary</span>
        <span class="db-denary-value" data-pbid="db-denary">${denary}</span>
      </div>
      <div class="db-bits" data-pbid="db-bits" data-bit-width="${bitWidth}">
        ${placeValues.map((pv, i) => `
          <button type="button" class="db-bit" data-pbid="db-bit" data-place="${pv}" data-pos="${i}" aria-pressed="false">
            <span class="db-bit-val">0</span>
            <span class="db-bit-place">${pv}</span>
          </button>
        `).join('')}
      </div>
      <div class="check-row">
        <button type="button" class="check-btn" data-pb="check">Check</button>
        <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  function clampBitWidth(w) {
    const n = parseInt(w, 10);
    if (!Number.isFinite(n)) return 8;
    return Math.max(1, Math.min(16, n));
  }
  function clampDenary(d, bitWidth) {
    const n = parseInt(d, 10);
    if (!Number.isFinite(n)) return 0;
    const max = Math.pow(2, bitWidth) - 1;
    return Math.max(0, Math.min(max, n));
  }
  // expectedBits(denary, bitWidth) — left-pad the binary representation
  // of denary to bitWidth bits so the comparison handles leading zeros
  // (e.g. denary 5 in 8 bits is "00000101", not "101").
  function expectedBits(denary, bitWidth) {
    const bin = (parseInt(denary, 10) || 0).toString(2);
    return bin.padStart(bitWidth, '0');
  }

  function renderAccordion(b) {
    const d = b.data;
    const items = d.items || [];
    return `<div class="accordion">${items.map((it, i) => `
      <div class="acc-item" data-acc="${i}">
        <div class="acc-head" onclick="this.parentElement.classList.toggle('open')">
          <span class="caret">▶</span>
          <span>${escapeHtml(it.title || `Item ${i + 1}`)}</span>
        </div>
        <div class="acc-body">${renderMarkdown(it.markdown || '')}</div>
      </div>
    `).join('')}</div>`;
  }

  function renderTabs(b) {
    const d = b.data;
    const items = d.items || [];
    if (!items.length) return '<p style="color:var(--text-4)">[Tabs: empty]</p>';
    return `<div class="tabs" data-pbid="tabs-root">
      <div class="tab-bar">
        ${items.map((it, i) => `<button type="button" class="tab ${i === 0 ? 'active' : ''}" data-tab="${i}">${escapeHtml(it.label || `Tab ${i + 1}`)}</button>`).join('')}
      </div>
      <div class="tab-body">${renderMarkdown(items[0].markdown || '')}</div>
    </div>`;
  }

  function renderTimeline(b) {
    const d = b.data;
    const items = d.items || [];
    return `<div class="timeline">${items.map(it => `
      <div class="tl-item">
        <div class="tl-date">${escapeHtml(it.date || '')}</div>
        <div class="tl-title">${escapeHtml(it.title || '')}</div>
        <div class="tl-body">${renderMarkdown(it.markdown || '')}</div>
      </div>
    `).join('')}</div>`;
  }

  function renderObjectives(b) {
    const d = b.data;
    const items = d.items || [];
    if (!items.length) return '<p style="color:var(--text-4)">[Objectives: empty]</p>';
    return `<div class="objectives">${items.map((it, i) => `
      <label class="obj-item" data-obj="${i}">
        <input type="checkbox" onclick="this.parentElement.classList.toggle('done', this.checked)" />
        <span>${escapeHtml(it.text || '')}</span>
      </label>
    `).join('')}</div>`;
  }

  function renderGlossary(b) {
    const d = b.data;
    const items = d.items || [];
    if (!items.length) return '<p style="color:var(--text-4)">[Glossary: empty]</p>';
    return `<div class="glossary">${items.map(it => `
      <div class="gloss-row">
        <div class="gloss-term">${escapeHtml(it.term || '')}</div>
        <div class="gloss-def">${escapeHtml(it.definition || '')}</div>
      </div>
    `).join('')}</div>`;
  }

  // ---------- BLOCK_DEFS (all 25 kinds) ------------------------------------

  const BLOCK_DEFS = {
    heading: {
      label: 'Heading',
      defaults: () => ({ level: 2, text: 'New heading' }),
      render: (b) => {
        const lvl = b.data.level === 3 ? 3 : 2;
        return `<h${lvl}>${escapeHtml(b.data.text || '')}</h${lvl}>`;
      }
    },
    text: {
      label: 'Text',
      defaults: () => ({ markdown: 'Write your explanation here.' }),
      render: (b) => renderMarkdown(b.data.markdown || '')
    },
    callout: {
      label: 'Callout',
      defaults: () => ({ tone: 'tip', markdown: 'A quick tip for the student.' }),
      render: (b) => {
        const tone = ['tip','warning','definition'].includes(b.data.tone) ? b.data.tone : 'tip';
        const icon = tone === 'tip' ? '💡' : tone === 'warning' ? '⚠️' : '📖';
        return `<div class="callout ${tone}"><div class="icon">${icon}</div><div class="body">${renderMarkdown(b.data.markdown || '')}</div></div>`;
      }
    },
    image: {
      label: 'Image',
      defaults: () => ({ url: '', alt: '', caption: '' }),
      render: (b) => {
        if (!b.data.url) return '<p style="color:var(--text-4)">[Image: no URL]</p>';
        const cap = b.data.caption ? `<figcaption>${escapeHtml(b.data.caption)}</figcaption>` : '';
        return `<figure><img src="${escapeHtml(b.data.url)}" alt="${escapeHtml(b.data.alt || '')}" />${cap}</figure>`;
      }
    },
    video: {
      label: 'Video',
      defaults: () => ({ provider: 'youtube', url: '' }),
      render: (b) => {
        const src = videoEmbedUrl(b.data.url, b.data.provider);
        if (!src) return '<p style="color:var(--text-4)">[Video: paste a valid URL]</p>';
        return `<div class="video-frame"><iframe src="${escapeHtml(src)}" allowfullscreen loading="lazy"></iframe></div>`;
      }
    },
    math: {
      label: 'Math',
      defaults: () => ({ latex: 'E = mc^2', display: true }),
      render: (b) => {
        const tex = b.data.latex || '';
        try {
          if (!window.katex) return `<code>${escapeHtml(tex)}</code>`;
          const html = window.katex.renderToString(tex, {
            displayMode: !!b.data.display, throwOnError: false
          });
          return b.data.display
            ? `<div class="math-display">${html}</div>`
            : `<span class="math-inline">${html}</span>`;
        } catch (e) {
          return '<p style="color:var(--red)">[Math: invalid LaTeX]</p>';
        }
      }
    },
    keypoints: {
      label: 'Key points',
      defaults: () => ({ items: ['First key point', 'Second key point'] }),
      render: (b) => {
        const items = (b.data.items || []).filter(i => i && i.trim());
        if (!items.length) return '<p style="color:var(--text-4)">[Key points: empty]</p>';
        return `<div class="keypoints"><ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;
      }
    },
    worked_example: {
      label: 'Worked example',
      defaults: () => ({ question: 'Solve x² = 9.', steps: [{ label: 'Step 1', body: 'Take the square root of both sides.' }], answer: 'x = ±3' }),
      render: (b) => {
        const steps = b.data.steps || [];
        return `<div class="worked">
          <div class="q">${escapeHtml(b.data.question || '')}</div>
          ${steps.map(s => `<div class="step"><b>${escapeHtml(s.label || '')}</b><div>${renderMarkdown(s.body || '')}</div></div>`).join('')}
          ${b.data.answer ? `<div class="ans">${escapeHtml(b.data.answer)}</div>` : ''}
        </div>`;
      }
    },
    reveal: {
      label: 'Reveal',
      defaults: () => ({ prompt: 'What is the capital of France?', explanation: 'Paris. The largest city in France, on the river Seine.' }),
      render: (b) => {
        return `<div class="reveal" onclick="this.classList.toggle('open')">
          <div class="prompt">${escapeHtml(b.data.prompt || '')}</div>
          <button type="button" class="toggle">Show answer</button>
          <div class="answer">${renderMarkdown(b.data.explanation || '')}</div>
        </div>`;
      }
    },
    flashcard: {
      label: 'Flashcard',
      defaults: () => ({ front: 'Photosynthesis', back: 'The process by which green plants use sunlight to synthesise food from CO₂ and water.', study: false }),
      render: (b) => {
        const d = b.data || {};
        const studyControls = d.study ? `
          <div class="flashcard-study" hidden>
            <button type="button" class="fcstudy-btn got" data-fcstudy="got">✓ Got it</button>
            <button type="button" class="fcstudy-btn miss" data-fcstudy="miss">✗ Missed it</button>
          </div>
          <div class="flashcard-study-result" hidden></div>
        ` : '';
        return `<div class="flashcard-wrap" data-fcstudy-mode="${d.study ? '1' : '0'}">
          <div class="flashcard" onclick="this.classList.toggle('flipped')">
            <div class="flashcard-inner">
              <div class="flashcard-face flashcard-front">${escapeHtml(d.front || '')}</div>
              <div class="flashcard-face flashcard-back">${escapeHtml(d.back || '')}</div>
            </div>
          </div>
          ${studyControls}
        </div>`;
      }
    },

    // Interactive practice
    mcq: { label: 'Multiple choice', defaults: () => ({ prompt: 'Which organelle is the powerhouse of the cell?', multi: false, options: [{ text: 'Nucleus', correct: false, feedback: 'The nucleus stores DNA, but it is not the energy producer.' }, { text: 'Mitochondrion', correct: true, feedback: 'Correct — mitochondria carry out aerobic respiration, producing ATP.' }, { text: 'Ribosome', correct: false, feedback: 'Ribosomes synthesise proteins, not ATP.' }, { text: 'Golgi apparatus', correct: false, feedback: 'The Golgi packages and ships proteins.' }], explanation: 'Mitochondria are often called the powerhouse of the cell because they generate most of the cell\'s ATP through aerobic respiration.', required: false, allowRetry: true }), render: renderMCQ },
    truefalse: { label: 'True / False', defaults: () => ({ prompt: 'The Earth orbits the Sun once every 365.25 days.', answer: true, instantMode: false, explanation: 'A sidereal year is approximately 365.256 days; the .25 is why we add a leap day every four years.', required: false, allowRetry: true }), render: renderTrueFalse },
    shortanswer: { label: 'Short answer', defaults: () => ({ prompt: 'What is the chemical symbol for gold?', answers: ['Au', 'au'], explanation: 'Gold\'s symbol comes from its Latin name, *aurum*.', required: false, allowRetry: true }), render: renderShortAnswer },
    fillblank: { label: 'Fill in the blank', defaults: () => ({ text: 'Photosynthesis converts carbon ___ and water into glucose and ___ using sunlight.', blanks: [{ answer: 'dioxide' }, { answer: 'oxygen' }], explanation: 'The general equation is 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂.', required: false, allowRetry: true }), render: renderFillBlank },
    match: { label: 'Match pairs', defaults: () => ({ prompt: 'Match each scientist to their discovery.', pairs: [{ left: 'Newton', right: 'Laws of motion' }, { left: 'Darwin', right: 'Natural selection' }, { left: 'Mendel', right: 'Inheritance' }, { left: 'Curie', right: 'Radioactivity' }], required: false, allowRetry: true }), render: renderMatch },
    ordering: { label: 'Order steps', defaults: () => ({ prompt: 'Put these steps of the scientific method in the correct order.', items: [{ id: 'a', text: 'Form a hypothesis' }, { id: 'b', text: 'Make an observation' }, { id: 'c', text: 'Analyse the data' }, { id: 'd', text: 'Draw a conclusion' }], explanation: 'A typical scientific method: observe → hypothesise → experiment → analyse → conclude.', required: false, allowRetry: true }), render: renderOrdering },
    hotspot: { label: 'Image hotspot', defaults: () => ({ imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/640px-Cat03.jpg', alt: 'A cat', hotspots: [{ x: 50, y: 40, label: 'Ear', correct: true }, { x: 30, y: 70, label: 'Whiskers', correct: false }], required: false, allowRetry: true }), render: renderHotspot },
    denary_binary: { label: 'Denary → binary', defaults: () => ({ prompt: 'Convert the following denary number to binary.', denary: 173, bitWidth: 8, explanation: '', required: false, allowRetry: true }), render: renderDenaryBinary },

    // ===== New interactive kinds (2026-07-24) =====

    // renderSlider(b) — drag a handle along a track to a numeric value.
    // Real-time tolerance check: as the user drags, the value badge and
    // the handle flash green when within tolerance of the correct value.
    // On Check, score = 1.0 if within tolerance else 0.0.
    slider: {
      label: 'Slider',
      defaults: () => ({ prompt: 'Estimate the answer.', min: 0, max: 100, step: 1, unit: '', correct: 50, tolerance: 5, explanation: '', required: false, allowRetry: true }),
      render: (b) => {
        const d = b.data || {};
        const min = Number.isFinite(+d.min) ? +d.min : 0;
        const max = Number.isFinite(+d.max) ? +d.max : 100;
        const step = Number.isFinite(+d.step) && +d.step > 0 ? +d.step : 1;
        const correct = Number.isFinite(+d.correct) ? +d.correct : (min + max) / 2;
        const tolerance = Number.isFinite(+d.tolerance) ? Math.abs(+d.tolerance) : 0;
        const unit = d.unit || '';
        return practiceWrap(`
          <div class="prompt">${escapeHtml(d.prompt || 'Drag the slider to your answer.')}</div>
          <div class="slider-wrap" data-pbid="slider-wrap" data-correct="${correct}" data-tolerance="${tolerance}" data-min="${min}" data-max="${max}">
            <div class="slider-track" data-pbid="slider-track">
              <div class="slider-fill" data-pbid="slider-fill"></div>
              <div class="slider-handle" data-pbid="slider-handle" tabindex="0" role="slider" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${correct}">
                <div class="slider-handle-dot"></div>
              </div>
              <div class="slider-tick" data-pbid="slider-tick" style="left:0%;opacity:0;"></div>
            </div>
            <div class="slider-readout">
              <span class="slider-value" data-pbid="slider-value">${correct}</span>
              <span class="slider-unit">${escapeHtml(unit)}</span>
              <span class="slider-range">${min}–${max}${escapeHtml(unit)}</span>
            </div>
          </div>
          <div class="check-row">
            <button type="button" class="check-btn" data-pb="check">Check</button>
            <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
          </div>
          <div data-pb="feedback"></div>
        `);
      }
    },

    // renderDial(b) — click-drag rotates an SVG needle. Snaps to `step`.
    // On Check, score is binary: 1.0 if |got − correct| ≤ tolerance.
    dial: {
      label: 'Dial',
      defaults: () => ({ prompt: 'Set the dial to the right position.', min: 0, max: 360, step: 10, correct: 90, tolerance: 15, unit: '°', explanation: '', required: false, allowRetry: true }),
      render: (b) => {
        const d = b.data || {};
        const min = Number.isFinite(+d.min) ? +d.min : 0;
        const max = Number.isFinite(+d.max) ? +d.max : 360;
        const step = Number.isFinite(+d.step) && +d.step > 0 ? +d.step : 1;
        const correct = Number.isFinite(+d.correct) ? +d.correct : (min + max) / 2;
        const tolerance = Number.isFinite(+d.tolerance) ? Math.abs(+d.tolerance) : 0;
        const unit = d.unit || '';
        const range = max - min;
        const startDeg = min + (range * 0.25); // start at 25% across the range
        return practiceWrap(`
          <div class="prompt">${escapeHtml(d.prompt || 'Drag the dial.')}</div>
          <div class="dial-wrap" data-pbid="dial-wrap" data-correct="${correct}" data-tolerance="${tolerance}" data-min="${min}" data-max="${max}" data-step="${step}">
            <div class="dial-svg-wrap">
              <svg class="dial-svg" viewBox="0 0 200 200" data-pbid="dial-svg" aria-label="Dial">
                <circle class="dial-face" cx="100" cy="100" r="88" />
                <g class="dial-ticks"></g>
                <line class="dial-needle" data-pbid="dial-needle" x1="100" y1="100" x2="100" y2="30" />
                <circle class="dial-pivot" cx="100" cy="100" r="8" />
              </svg>
            </div>
            <div class="dial-readout">
              <span class="dial-value" data-pbid="dial-value">${startDeg}</span>
              <span class="dial-unit">${escapeHtml(unit)}</span>
              <span class="dial-hint">drag the dial</span>
            </div>
          </div>
          <div class="check-row">
            <button type="button" class="check-btn" data-pb="check">Check</button>
            <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
          </div>
          <div data-pb="feedback"></div>
        `);
      }
    },

    // renderSequence(b) — guided step-through with progress dots. Each
    // step may have an optional inline input (text or mcq). The student
    // moves forward with a Next button; a final Check button at the
    // last step fires onScore based on the inline input answers.
    sequence: {
      label: 'Step-through',
      defaults: () => ({ prompt: 'Work through each step.', steps: [{ title: 'Step 1', body: 'Read this carefully and click Next.', input: null }, { title: 'Step 2', body: 'Type the answer in your own words.', input: { type: 'text', answers: ['42', 'forty-two'] } }], required: false, allowRetry: true }),
      render: (b) => {
        const d = b.data || {};
        const steps = d.steps || [];
        if (!steps.length) return practiceWrap(`<div class="prompt">[Sequence: add steps in the editor]</div>`);
        return practiceWrap(`
          <div class="prompt">${escapeHtml(d.prompt || '')}</div>
          <div class="seq-dots" data-pbid="seq-dots">
            ${steps.map((_, i) => `<span class="seq-dot${i === 0 ? ' active' : ''}${i < steps.length - 1 ? '' : ' last'}" data-step="${i}">${i + 1}</span>${i < steps.length - 1 ? '<span class="seq-dot-line"></span>' : ''}`).join('')}
          </div>
          <div class="seq-steps" data-pbid="seq-steps">
            ${steps.map((s, i) => {
              const input = s.input || null;
              let inputHtml = '';
              if (input && input.type === 'text') {
                const w = Math.max(100, Math.min(280, ((input.answers && input.answers[0]) || '').length * 12 + 60));
                inputHtml = `<div class="seq-input-wrap"><input type="text" class="sa-input" data-seq-input="i" data-idx="${i}" placeholder="Your answer…" style="width:${w}px;" /></div>`;
              } else if (input && input.type === 'mcq') {
                const opts = input.options || [];
                inputHtml = `<div class="seq-mcq" data-seq-mcq="${i}">${opts.map((o, oi) => `<button type="button" class="opt" data-seq-opt="${i}-${oi}" data-correct="${!!o.correct}"><span>${escapeHtml(o.text || '')}</span></button>`).join('')}</div>`;
              }
              return `<div class="seq-step${i === 0 ? ' active' : ''}" data-step="${i}">
                <div class="seq-step-title">${escapeHtml(s.title || `Step ${i + 1}`)}</div>
                <div class="seq-step-body">${renderMarkdown(s.body || '')}</div>
                ${inputHtml}
              </div>`;
            }).join('')}
          </div>
          <div class="check-row">
            <button type="button" class="seq-btn seq-prev" data-seq="prev" hidden>← Back</button>
            <button type="button" class="seq-btn seq-next" data-seq="next">Next →</button>
            <button type="button" class="check-btn seq-check" data-pb="check" hidden>Check</button>
            <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
          </div>
          <div data-pb="feedback"></div>
        `);
      }
    },

    // renderConnect(b) — click two endpoints on an SVG to draw a line.
    // Used for graph/circuit/anatomy pairings. Points are placed by
    // (x%, y%) on the canvas; edges list which pairs are correct.
    connect: {
      label: 'Connect points',
      defaults: () => ({ prompt: 'Connect each labelled point to the right partner. (Click two points in a row to draw a line between them.)', canvasWidth: 600, canvasHeight: 360, points: [{ id: 'A', x: 15, y: 50, label: 'A' }, { id: 'B', x: 50, y: 20, label: 'B' }, { id: 'C', x: 50, y: 80, label: 'C' }, { id: 'D', x: 85, y: 50, label: 'D' }], edges: [{ from: 'A', to: 'B' }, { from: 'C', to: 'D' }], required: false, allowRetry: true }),
      render: (b) => {
        const d = b.data || {};
        const pts = d.points || [];
        const w = Number.isFinite(+d.canvasWidth) ? +d.canvasWidth : 600;
        const h = Number.isFinite(+d.canvasHeight) ? +d.canvasHeight : 360;
        if (!pts.length) return practiceWrap(`<div class="prompt">[Connect: add points in the editor]</div>`);
        return practiceWrap(`
          <div class="prompt">${escapeHtml(d.prompt || 'Connect the points.')}</div>
          <div class="connect-wrap" data-pbid="connect-wrap">
            <svg class="connect-svg" viewBox="0 0 100 60" preserveAspectRatio="none" data-pbid="connect-svg">
              <g class="connect-edges" data-pbid="connect-edges"></g>
            </svg>
            <div class="connect-canvas" data-pbid="connect-canvas" style="aspect-ratio:${w} / ${h};">
              ${pts.map(p => `<button type="button" class="connect-pt" data-pt="${escapeHtml(p.id)}" style="left:${p.x}%;top:${p.y}%;">
                <span class="connect-pt-dot"></span>
                <span class="connect-pt-label">${escapeHtml(p.label || p.id)}</span>
              </button>`).join('')}
            </div>
          </div>
          <div class="connect-hint">Connections: <span data-pbid="connect-count">0</span></div>
          <div class="check-row">
            <button type="button" class="check-btn" data-pb="check">Check</button>
            <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
          </div>
          <div data-pb="feedback"></div>
        `);
      }
    },

    // renderPile(b) — drag items into Yes / No / Maybe buckets.
    pile: {
      label: 'Sort into piles',
      defaults: () => ({ prompt: 'Drag each item into a pile.', items: [{ text: 'It will definitely happen.', category: 'yes' }, { text: 'It will definitely not happen.', category: 'no' }, { text: 'It might happen, but we\'re not sure.', category: 'maybe' }, { text: 'It already happened.', category: 'yes' }], required: false, allowRetry: true }),
      render: (b) => {
        const d = b.data || {};
        const items = d.items || [];
        if (!items.length) return practiceWrap(`<div class="prompt">[Pile: add items in the editor]</div>`);
        const labels = { yes: 'Yes', no: 'No', maybe: 'Maybe' };
        const buckets = ['yes', 'no', 'maybe'];
        return practiceWrap(`
          <div class="prompt">${escapeHtml(d.prompt || 'Drag each item into a pile.')}</div>
          <div class="pile-grid" data-pbid="pile-grid">
            ${buckets.map(bk => `<div class="pile-bucket" data-bucket="${bk}">
              <div class="pile-bucket-head">${labels[bk]}<span class="pile-count" data-count="${bk}">0</span></div>
              <div class="pile-bucket-body" data-bucket-body="${bk}"></div>
            </div>`).join('')}
          </div>
          <div class="pile-pool" data-pbid="pile-pool">
            ${items.map((it, i) => `<button type="button" class="pile-item" draggable="true" data-idx="${i}" data-correct="${escapeHtml(it.category || 'yes')}">
              <span class="pile-item-grip">⋮⋮</span><span>${escapeHtml(it.text || '')}</span>
            </button>`).join('')}
          </div>
          <div class="check-row">
            <button type="button" class="check-btn" data-pb="check">Check</button>
            <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
          </div>
          <div data-pb="feedback"></div>
        `);
      }
    },

    // ===== New study aids (display-only — no onScore) =====

    // mindmap — central concept with radiating branches (SVG).
    mindmap: {
      label: 'Mind map',
      defaults: () => ({ center: 'Photosynthesis', branches: [{ label: 'Inputs', items: ['CO₂', 'Water', 'Sunlight'] }, { label: 'Outputs', items: ['Glucose', 'Oxygen'] }, { label: 'Where', items: ['Chloroplasts', 'Leaves'] }] }),
      render: (b) => {
        const d = b.data || {};
        const branches = d.branches || [];
        if (!branches.length) return '<p style="color:var(--text-4)">[Mind map: add branches in the editor]</p>';
        // Distribute branches evenly around the centre. Use top half +
        // bottom half so the layout is balanced.
        const n = branches.length;
        const positions = branches.map((_, i) => {
          const angle = (-Math.PI / 2) + (i * (2 * Math.PI / n));
          const x = 50 + Math.cos(angle) * 36;
          const y = 50 + Math.sin(angle) * 36;
          return { x, y };
        });
        return `<div class="mindmap" data-pbid="mindmap">
          <svg class="mindmap-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
            ${branches.map((_, i) => {
              const p = positions[i];
              return `<line class="mindmap-edge" x1="50" y1="50" x2="${p.x}" y2="${p.y}" />`;
            }).join('')}
            <circle class="mindmap-center" cx="50" cy="50" r="11" />
            <text class="mindmap-center-text" x="50" y="50">${escapeHtml(d.center || '')}</text>
            ${branches.map((br, i) => {
              const p = positions[i];
              const items = (br.items || []).map(t => `<li>${escapeHtml(t)}</li>`).join('');
              return `<g class="mindmap-branch" data-bi="${i}">
                <circle class="mindmap-node" cx="${p.x}" cy="${p.y}" r="7" />
                <text class="mindmap-node-label" x="${p.x}" y="${p.y - 10}">${escapeHtml(br.label || '')}</text>
                <foreignObject class="mindmap-items-wrap" x="${Math.max(0, p.x - 18)}" y="${p.y + 10}" width="36" height="40">
                  <div xmlns="http://www.w3.org/1999/xhtml" class="mindmap-items"><ul>${items}</ul></div>
                </foreignObject>
              </g>`;
            }).join('')}
          </svg>
        </div>`;
      }
    },

    // flashcard_stack — full deck with shuffle + progress counter.
    flashcard_stack: {
      label: 'Flashcard deck',
      defaults: () => ({ cards: [{ front: 'Mitochondrion', back: 'The organelle responsible for aerobic respiration and ATP production.' }, { front: 'Ribosome', back: 'The site of protein synthesis in the cell.' }, { front: 'Nucleus', back: 'Stores the cell\'s DNA and controls gene expression.' }], shuffle: false }),
      render: (b) => {
        const d = b.data || {};
        const cards = d.cards || [];
        if (!cards.length) return '<p style="color:var(--text-4)">[Flashcard deck: add cards in the editor]</p>';
        const cardsAttr = JSON.stringify(cards).replace(/"/g, '&quot;');
        return `<div class="fcdeck" data-pbid="fcdeck" data-shuffle="${d.shuffle ? '1' : '0'}" data-cards="${cardsAttr}">
          <div class="fcdeck-progress"><span data-pbid="fcdeck-pos">1</span> / <span data-pbid="fcdeck-total">${cards.length}</span></div>
          <div class="fcdeck-stage" data-pbid="fcdeck-stage">
            <div class="fcdeck-card" data-side="front">${escapeHtml(cards[0].front || '')}</div>
            <div class="fcdeck-card back" data-side="back" hidden>${escapeHtml(cards[0].back || '')}</div>
          </div>
          <div class="fcdeck-controls">
            <button type="button" class="fcdeck-btn" data-fcdeck="prev">← Previous</button>
            <button type="button" class="fcdeck-btn primary" data-fcdeck="flip">Flip</button>
            <button type="button" class="fcdeck-btn" data-fcdeck="next">Next →</button>
            <button type="button" class="fcdeck-btn ghost" data-fcdeck="shuffle">Shuffle</button>
          </div>
        </div>`;
      }
    },

    // progress_meter — confidence-rating checklist with a live progress
    // bar. Pure display, no scoring.
    progress_meter: {
      label: 'Progress meter',
      defaults: () => ({ title: 'How confident are you?', items: ['Define a covalent bond', 'Draw a dot-and-cross diagram', 'Explain the difference between polar and non-polar bonds'] }),
      render: (b) => {
        const d = b.data || {};
        const items = d.items || [];
        if (!items.length) return '<p style="color:var(--text-4)">[Progress meter: add items in the editor]</p>';
        const states = ['got', 'unsure', 'notyet'];
        const labels = { got: '✓ Got it', unsure: '? Unsure', notyet: '✗ Not yet' };
        return `<div class="prog-meter" data-pbid="prog-meter">
          <div class="prog-meter-head">
            <div class="prog-meter-title">${escapeHtml(d.title || 'How confident are you?')}</div>
            <div class="prog-meter-bar"><div class="prog-meter-fill" data-pbid="prog-meter-fill" style="width:0%;"></div></div>
            <div class="prog-meter-count"><span data-pbid="prog-meter-count">0</span> / ${items.length} confident</div>
          </div>
          <div class="prog-meter-list">
            ${items.map((it, i) => `<div class="prog-meter-row" data-row="${i}">
              <div class="prog-meter-text">${escapeHtml(it)}</div>
              <div class="prog-meter-pills" data-pills="${i}">
                ${states.map(s => `<button type="button" class="prog-meter-pill" data-state="${s}">${labels[s]}</button>`).join('')}
              </div>
            </div>`).join('')}
          </div>
        </div>`;
      }
    },

    // Layout & structure
    accordion: { label: 'Accordion', defaults: () => ({ items: [{ title: 'What is mitosis?', markdown: 'Mitosis is the process of cell division that produces two genetically identical daughter cells.' }, { title: 'What is meiosis?', markdown: 'Meiosis produces four non-identical gametes, halving the chromosome number.' }] }), render: renderAccordion },
    tabs: { label: 'Tabs', defaults: () => ({ items: [{ label: 'Definition', markdown: 'A **vector** is a quantity with both magnitude and direction.' }, { label: 'Example', markdown: 'Velocity is a vector — 30 m/s north is different from 30 m/s east.' }, { label: 'In equations', markdown: 'We write vectors in **bold** (e.g. **v**) or with an arrow (\\vec{v}).' }] }), render: renderTabs },
    compare: {
      label: 'Compare',
      defaults: () => ({ leftTitle: 'Mitosis', rightTitle: 'Meiosis', leftMarkdown: '• Produces 2 daughter cells\n• Genetically identical\n• One division', rightMarkdown: '• Produces 4 daughter cells\n• Genetically unique\n• Two divisions' }),
      render: (b) => {
        const lt = b.data.leftTitle || 'Left';
        const rt = b.data.rightTitle || 'Right';
        return `<div class="compare-grid">
          <div class="col"><h4>${escapeHtml(lt)}</h4>${renderMarkdown(b.data.leftMarkdown || '')}</div>
          <div class="col"><h4>${escapeHtml(rt)}</h4>${renderMarkdown(b.data.rightMarkdown || '')}</div>
        </div>`;
      }
    },
    timeline: { label: 'Timeline', defaults: () => ({ items: [{ date: '1939', title: 'War begins', markdown: 'Germany invades Poland; Britain and France declare war.' }, { date: '1941', title: 'Operation Barbarossa', markdown: 'Germany invades the Soviet Union.' }, { date: '1944', title: 'D-Day', markdown: 'Allied forces land on the beaches of Normandy.' }, { date: '1945', title: 'War ends', markdown: 'Germany surrenders in May; Japan in September after the atomic bombings.' }] }), render: renderTimeline },

    // Study aids
    objectives: { label: 'Objectives', defaults: () => ({ items: [{ text: 'Describe the structure of a mitochondrion' }, { text: 'Explain the role of ATP in cells' }, { text: 'Compare aerobic and anaerobic respiration' }] }), render: renderObjectives },
    prerequisites: {
      label: 'Prerequisites',
      defaults: () => ({ items: [{ text: 'You should be comfortable with the structure of an animal cell.' }, { text: 'You should know what enzymes are and how they speed up reactions.' }] }),
      render: (b) => {
        const items = (b.data.items || []).map(t => typeof t === 'string' ? t : (t && t.text) || '').filter(t => t && t.trim());
        if (!items.length) return '<p style="color:var(--text-4)">[Prerequisites: empty]</p>';
        return `<div class="prereqs">${items.map(t => `<div class="prereq-item">${escapeHtml(t)}</div>`).join('')}</div>`;
      }
    },
    glossary: { label: 'Glossary', defaults: () => ({ items: [{ term: 'Atom', definition: 'The smallest unit of a chemical element.' }, { term: 'Molecule', definition: 'Two or more atoms bonded together.' }, { term: 'Ion', definition: 'An atom or molecule with a net electric charge.' }] }), render: renderGlossary },
    summary: {
      label: 'Summary',
      defaults: () => ({ keyTakeaways: ['Mitochondria are the site of aerobic respiration.', 'ATP is the universal energy currency of the cell.', 'Anaerobic respiration produces lactate in animals.'], markdown: 'This lesson covered the structure of the mitochondrion, the stages of aerobic respiration (glycolysis, the link reaction, the Krebs cycle, and oxidative phosphorylation), and the difference between aerobic and anaerobic respiration.' }),
      render: (b) => {
        const ks = (b.data.keyTakeaways || []).filter(t => t && t.trim());
        return `<div class="summary-card">
          <h4>Key takeaways</h4>
          ${ks.length ? `<ul class="takeaways">${ks.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
          <div class="body">${renderMarkdown(b.data.markdown || '')}</div>
        </div>`;
      }
    },

    // ---------- 6 new block kinds (2026-07) ----------
    audio: {
      label: 'Audio',
      defaults: () => ({ url: '', caption: '' }),
      render: (b) => {
        const d = b.data || {};
        if (!d.url) return '<p style="color:var(--text-4)">[Audio: paste a URL or upload a file]</p>';
        const cap = d.caption ? `<figcaption>${escapeHtml(d.caption)}</figcaption>` : '';
        return `<figure><audio controls src="${escapeHtml(d.url)}" style="width:100%;"></audio>${cap}</figure>`;
      }
    },
    divider: {
      label: 'Divider',
      defaults: () => ({ title: '' }),
      render: (b) => {
        const t = (b.data && b.data.title || '').trim();
        if (!t) return '<hr class="divider-rule" />';
        return `<div class="divider"><hr /><span>${escapeHtml(t)}</span><hr /></div>`;
      }
    },
    quote: {
      label: 'Pull quote',
      defaults: () => ({ text: 'Mitochondria are the powerhouse of the cell.', attribution: '' }),
      render: (b) => {
        const d = b.data || {};
        const cite = d.attribution ? `<cite>— ${escapeHtml(d.attribution)}</cite>` : '';
        return `<blockquote class="pull-quote">${escapeHtml(d.text || '')}${cite}</blockquote>`;
      }
    },
    cardset: {
      label: 'Card set',
      defaults: () => ({ cards: [
        { front: 'Mitochondrion', back: 'The site of aerobic respiration in eukaryotic cells.' },
        { front: 'Ribosome',       back: 'The site of protein synthesis.' },
        { front: 'Nucleus',        back: 'Contains the cell\'s DNA.' }
      ] }),
      render: (b) => {
        const cards = (b.data && b.data.cards) || [];
        if (!cards.length) return '<p style="color:var(--text-4)">[Card set: empty]</p>';
        return `<div class="cardset-stack">${cards.map((c, i) => `
          <div class="flashcard" onclick="this.classList.toggle('flipped')">
            <div class="flashcard-inner">
              <div class="flashcard-face flashcard-front">${escapeHtml(c.front || '')}</div>
              <div class="flashcard-face flashcard-back">${escapeHtml(c.back || '')}</div>
            </div>
          </div>`).join('')}</div>`;
      }
    },
    steps: {
      label: 'Numbered steps',
      defaults: () => ({ items: [
        { title: 'Observe',  body: 'Make a careful observation of the phenomenon.' },
        { title: 'Hypothesise', body: 'Form a testable hypothesis to explain it.' },
        { title: 'Experiment', body: 'Design and run a controlled experiment.' },
        { title: 'Conclude', body: 'Analyse the data and draw a conclusion.' }
      ] }),
      render: (b) => {
        const items = (b.data && b.data.items) || [];
        if (!items.length) return '<p style="color:var(--text-4)">[Steps: empty]</p>';
        return `<ol class="steps-list">${items.map(it => `
          <li class="step-item">
            <div class="step-title">${escapeHtml(it.title || '')}</div>
            <div class="step-body">${renderMarkdown(it.body || '')}</div>
          </li>`).join('')}</ol>`;
      }
    },
    categorise: {
      label: 'Categorise',
      defaults: () => ({ prompt: 'Sort each item into the correct category.', categories: [
        { name: 'Acids',   items: ['Hydrochloric acid', 'Citric acid'] },
        { name: 'Bases',   items: ['Sodium hydroxide', 'Ammonia'] },
        { name: 'Oxides',  items: ['Carbon dioxide', 'Iron oxide'] }
      ], required: false, allowRetry: true }),
      render: renderCategorise
    },

    // ---------- html block (interactive iframe) ----------
    // The HTML block lets an author drop in arbitrary HTML/CSS/JS as a
    // sandboxed <iframe>. The iframe runs in a null origin (sandbox="allow-scripts"
    // only) so it cannot reach the parent page's Supabase client, auth
    // session, or DOM. The author signals "this activity is done" by
    // declaring window.RecallGame = { register({onComplete}) { ... onComplete(); } }
    // in the iframe; we route that to a postMessage the parent listens for.
    // See supabase_uploads.sql (CHECK widening) and lesson.html
    // (postMessage listener, completion gate) for the rest.
    html: {
      label: 'HTML (interactive)',
      defaults: () => ({
        html: '<button id="finish">Mark activity done</button>',
        css:  '#finish { padding: 10px 16px; background: #58A6FF; color: white; border: 0; border-radius: 6px; font-size: 14px; cursor: pointer; }\n#finish:hover { background: #1F6FEB; }',
        js:   'document.getElementById("finish").onclick = function() {\n  // Tell the parent the activity is done.\n  parent.postMessage({ type: "recall-block-complete", score: 1, total: 1 }, "*");\n};',
        scriptImport: '',
        required: false,
        height: 360,
      }),
      render: renderHtmlBlock
    }
  };

  // renderHtmlBlock(b) — wrap an iframe in a stable div that the student
  // player can find via [data-block-id]. The iframe is the only render
  // surface; the "Required to complete" UI is layered on by lesson.html
  // once the postMessage fires.
  function renderHtmlBlock(b) {
    const d = b.data || {};
    const height = Math.max(80, Math.min(2000, parseInt(d.height, 10) || 360));
    const srcdoc = buildHtmlSrcdoc(d, b.id);
    return `<div class="html-block" data-block-id="${escapeHtml(b.id || '')}" data-required="${d.required ? 'true' : 'false'}">
      <iframe class="html-block-iframe" sandbox="allow-scripts" srcdoc="${srcdoc}" title="Interactive content" loading="lazy"></iframe>
      ${d.required ? '<div class="html-block-gate" hidden><span>✓ Completed — you can continue.</span></div>' : ''}
    </div>`;
  }

  // buildHtmlSrcdoc(data, blockId) — assemble the iframe's source document.
  // Author content is concatenated into a single srcdoc string. We rely on
  // the attribute-quote-escape performed by the caller (renderHtmlBlock),
  // since we are inside an attribute value. Within the document itself the
  // author's HTML/JS runs as written — we are not sanitising the author's
  // own content. The sandbox prevents the content from reaching the
  // parent; the parent validates postMessage by content (type +
  // blockId), not origin, because the iframe has a null origin.
  function buildHtmlSrcdoc(data, blockId) {
    const safeId = String(blockId || '').replace(/[^A-Za-z0-9_-]/g, '');
    const safeImport = String(data.scriptImport || '').trim();
    // Validate the import URL: only http(s). The author's own page can
    // be anything; we just refuse obvious nonsense like javascript:.
    let importTag = '';
    if (safeImport) {
      let parsed = null;
      try { parsed = new URL(safeImport, location.href); } catch (_) {}
      if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
        importTag = `<script src="${escapeHtml(safeImport)}"></script>`;
      }
    }
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<style>html,body{margin:0;padding:0;background:transparent;color:#F0F6FC;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      String(data.css || ''),
      '</style></head><body>',
      String(data.html || ''),
      importTag,
      '<script>(function(){',
        'var BLOCK_ID=' + JSON.stringify(safeId) + ';',
        'var tries=0;',
        'function wire(){',
          'if (window.RecallGame && typeof window.RecallGame.register === "function") {',
            'window.RecallGame.register({',
              'onComplete: function(payload) {',
                'parent.postMessage({',
                  'type: "recall-block-complete",',
                  'blockId: BLOCK_ID,',
                  'score: (payload && typeof payload.score === "number") ? payload.score : 1,',
                  'total: (payload && typeof payload.total === "number") ? payload.total : 1',
                '}, "*");',
              '}',
            '});',
          '} else if (tries++ < 50) {',
            'setTimeout(wire, 100);',
          '}',
        '}',
        'wire();',
        'try{',
          // Author's freeform JS runs after the shim is wired so
          // window.RecallGame.register calls from the import can race
          // with the author's inline code.
          '(function(){' + String(data.js || '') + '})();',
        '}catch(e){',
          'console.error("Author JS error:", e);',
        '}',
      '})();</script>',
      '</body></html>'
    ].join('');
  }

  // ---------- renderers for the new kinds ----------
  // renderCategorise(b) — items live at the top, category buckets below.
  // The student clicks an item, then a bucket; we record the assignment in
  // data-pick-* attributes that bindCategorise later scores.
  function renderCategorise(b) {
    const d = b.data || {};
    const cats = d.categories || [];
    // Flatten items with their correct category index.
    const items = [];
    cats.forEach((c, ci) => (c.items || []).forEach(t => items.push({ text: t, correct: ci })));
    if (!items.length) return practiceWrap(`<div class="prompt">[Categorise: add items in the editor]</div>`);
    // Shuffle so the items aren't in a predictable order.
    const shuffled = items.map(x => x);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return practiceWrap(`
      <div class="prompt">${escapeHtml(d.prompt || 'Sort each item into the correct category.')}</div>
      <div class="cat-items" data-pbid="cat-items">
        ${shuffled.map((it, i) => `<button type="button" class="cat-item" data-idx="${i}" data-correct="${it.correct}">${escapeHtml(it.text)}</button>`).join('')}
      </div>
      <div class="cat-grid" data-pbid="cat-buckets">
        ${cats.map((c, ci) => `<div class="cat-bucket" data-cat="${ci}">
          <div class="cat-bucket-head">${escapeHtml(c.name || `Category ${ci + 1}`)}</div>
          <div class="cat-bucket-body" data-bucket-body="${ci}"></div>
        </div>`).join('')}
      </div>
      <div class="check-row">
        <button type="button" class="check-btn" data-pb="check">Check</button>
        <button type="button" class="reset-btn" data-pb="reset" hidden>Try again</button>
      </div>
      <div data-pb="feedback"></div>
    `);
  }

  // ---------- interactivity wiring -----------------------------------------
  // attachInteractivity(blocks, container, onScore) walks every block in
  // `blocks`, finds the matching DOM node in `container` (rooted by
  // data-block-id), and wires up the appropriate event listeners. When
  // a block is "checked" (the student pressed the Check button), we
  // compute a score (1.0 / 0.5 / 0.0) and pass it to onScore(blockId, score, total).
  // onScore should return a promise; attachInteractivity does not await
  // it but it can be async.

  function showFeedback(rootEl, html, kind) {
    const fb = rootEl.querySelector('[data-pb="feedback"]');
    if (!fb) return;
    fb.innerHTML = `<div class="feedback ${kind}">${html}</div>`;
  }
  function clearFeedback(rootEl) {
    const fb = rootEl.querySelector('[data-pb="feedback"]');
    if (fb) fb.innerHTML = '';
  }
  function setCheckEnabled(rootEl, enabled) {
    const c = rootEl.querySelector('[data-pb="check"]');
    const r = rootEl.querySelector('[data-pb="reset"]');
    if (c) c.disabled = !enabled;
    if (r) r.hidden = enabled;
  }

  function bindMCQ(rootEl, d, blockId, onScore) {
    const opts = rootEl.querySelectorAll('[data-pbid="mcq-opts"] .opt');
    opts.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('correct') || btn.classList.contains('wrong')) return;
        if (d.multi) {
          btn.classList.toggle('selected');
        } else {
          opts.forEach(o => o.classList.remove('selected'));
          btn.classList.add('selected');
        }
        // Live feedback: if the student just picked a wrong option in
        // single-answer mode, shake it and show its per-option feedback
        // so they get a hint before pressing Check. The right answer
        // is still hidden (we only reveal it on Check).
        if (!d.multi) {
          const idx = parseInt(btn.dataset.idx, 10);
          const opt = (d.options || [])[idx] || {};
          if (!opt.correct) {
            // fx-shake — restart the animation by removing + reflowing.
            btn.classList.remove('fx-shake');
            void btn.offsetWidth;
            btn.classList.add('fx-shake');
            if (opt.feedback) {
              showFeedback(rootEl, `<b>Hint:</b> ${escapeHtml(opt.feedback)}`, 'info');
            }
          } else {
            clearFeedback(rootEl);
          }
        }
      });
    });
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    check.addEventListener('click', () => {
      const sel = [...opts].map((o, i) => o.classList.contains('selected') ? i : -1).filter(i => i >= 0);
      if (!sel.length) { showFeedback(rootEl, 'Pick an option first.', 'info'); return; }
      const isMulti = !!d.multi;
      const correctIdxs = (d.options || []).map((o, i) => o.correct ? i : -1).filter(i => i >= 0);
      const right = isMulti
        ? sel.length === correctIdxs.length && sel.every(i => correctIdxs.includes(i))
        : correctIdxs.includes(sel[0]);
      opts.forEach((o, i) => {
        const opt = (d.options || [])[i] || {};
        o.classList.remove('selected');
        if (opt.correct) o.classList.add('correct');
        else if (sel.includes(i)) o.classList.add('wrong');
      });
      const wrongSel = sel.find(i => !(d.options || [])[i].correct);
      let extra = '';
      if (wrongSel) extra = `<div style="margin-top:6px;"><b>${escapeHtml((d.options || [])[wrongSel].text)}:</b> ${escapeHtml((d.options || [])[wrongSel].feedback || '')}</div>`;
      if (right) {
        showFeedback(rootEl, `✓ Correct!${d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''}${extra}`, 'ok');
      } else {
        showFeedback(rootEl, `✗ Not quite.${d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''}${extra}`, 'bad');
      }
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
    });
    reset.addEventListener('click', () => {
      opts.forEach(o => o.classList.remove('selected', 'correct', 'wrong'));
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  function bindTrueFalse(rootEl, d, blockId, onScore) {
    const opts = rootEl.querySelectorAll('[data-pbid="tf-opts"] .opt');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    // If instantMode is on, the pick itself scores the answer — no
    // Check button needed. The button is hidden; reset still appears
    // after a pick so the student can change their mind.
    const instant = !!d.instantMode;
    if (instant && check) check.hidden = true;
    opts.forEach(btn => btn.addEventListener('click', () => {
      if (btn.classList.contains('correct') || btn.classList.contains('wrong')) return;
      opts.forEach(o => o.classList.remove('selected'));
      btn.classList.add('selected');
      if (instant) {
        // Score immediately, no Check button.
        const expected = d.answer === true ? 't' : 'f';
        const right = btn.dataset.idx === expected;
        opts.forEach(o => {
          o.classList.remove('selected');
          if (o.dataset.idx === expected) o.classList.add('correct');
          else o.classList.add('wrong');
        });
        if (!right) {
          btn.classList.remove('fx-shake');
          void btn.offsetWidth;
          btn.classList.add('fx-shake');
        }
        showFeedback(rootEl,
          `${right ? '✓ Correct!' : '✗ Not quite.'}${d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''}`,
          right ? 'ok' : 'bad'
        );
        if (reset) reset.hidden = (d.allowRetry === false);
        if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
      }
    }));
    // In instant mode the Check button is hidden; skip wiring it.
    if (!instant) {
      check.addEventListener('click', () => {
        const sel = [...opts].find(o => o.classList.contains('selected'));
        if (!sel) { showFeedback(rootEl, 'Pick true or false first.', 'info'); return; }
        const expected = d.answer === true ? 't' : 'f';
        const right = sel.dataset.idx === expected;
        opts.forEach(o => {
          o.classList.remove('selected');
          if (o.dataset.idx === expected) o.classList.add('correct');
          else o.classList.add('wrong');
        });
        if (!right) {
          sel.classList.remove('fx-shake');
          void sel.offsetWidth;
          sel.classList.add('fx-shake');
        }
        showFeedback(rootEl, `${right ? '✓ Correct!' : '✗ Not quite.'}${d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''}`, right ? 'ok' : 'bad');
        check.disabled = true; reset.hidden = (d.allowRetry === false);
        if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
      });
      reset.addEventListener('click', () => {
        opts.forEach(o => o.classList.remove('selected', 'correct', 'wrong'));
        clearFeedback(rootEl); setCheckEnabled(rootEl, true);
      });
    } else {
      // Reset still works in instant mode.
      if (reset) {
        reset.addEventListener('click', () => {
          opts.forEach(o => o.classList.remove('selected', 'correct', 'wrong'));
          clearFeedback(rootEl);
        });
      }
    }
  }

  function bindShortAnswer(rootEl, d, blockId, onScore) {
    const input = rootEl.querySelector('[data-pbid="sa-input"]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    const answers = (d.answers || []).map(normText);
    check.addEventListener('click', () => {
      const got = normText(input.value);
      if (!got) { showFeedback(rootEl, 'Type an answer first.', 'info'); return; }
      const right = answers.includes(got);
      showFeedback(rootEl,
        `${right ? '✓ Correct!' : `✗ Not quite — the answer was <code>${escapeHtml((d.answers || [])[0] || '')}</code>.`}` +
        (d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''),
        right ? 'ok' : 'bad'
      );
      input.disabled = true; check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
    });
    reset.addEventListener('click', () => {
      input.disabled = false; input.value = '';
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  function bindFillBlank(rootEl, d, blockId, onScore) {
    const inputs = rootEl.querySelectorAll('[data-fb]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    const blanks = d.blanks || [];
    // Real-time 70% auto-fill: as the student types, the moment they
    // cross the prefix threshold the rest of the answer drops in and
    // the input is locked into the completed word. A second keystroke
    // (any edit) unlocks it again so the student can correct a typo.
    // The 'input' event fires on every change — including the
    // auto-fill itself, which we guard against with .dataset.autofilled.
    inputs.forEach((inp, i) => {
      const want = (blanks[i] || {}).answer || '';
      inp.addEventListener('input', () => {
        if (inp.disabled) return;
        // If the student edits a previously-autofilled input, clear
        // the autofilled flag and the green styling — they're now in
        // control again.
        if (inp.dataset.autofilled === '1') {
          inp.dataset.autofilled = '0';
          inp.classList.remove('correct');
          // Strip the auto-filled tail so the student edits just what
          // they typed. We snapshot the typed length in the dataset
          // at fill time (see below) and restore to that prefix.
          const typedLen = parseInt(inp.dataset.typedLen || '0', 10);
          inp.value = inp.value.slice(0, typedLen);
          // Restore the caret to the end of what the student now has.
          const end = inp.value.length;
          try { inp.setSelectionRange(end, end); } catch (_) {}
          return;
        }
        if (!want) return;
        const completion = prefixFillEligible(inp.value, want);
        if (!completion) return;
        // Remember how many characters the student actually typed so
        // a follow-up edit can restore to that prefix.
        const typedLen = normText(inp.value).length;
        inp.value = completion;
        inp.dataset.autofilled = '1';
        inp.dataset.typedLen = String(typedLen);
        inp.classList.add('correct');
        // Move the caret to the end of the completed word so the
        // student sees the rest appear after their cursor.
        const end = inp.value.length;
        try { inp.setSelectionRange(end, end); } catch (_) {}
      });
    });
    check.addEventListener('click', () => {
      if (![...inputs].some(i => i.value)) { showFeedback(rootEl, 'Fill in the blanks first.', 'info'); return; }
      const results = [...inputs].map((inp, i) => {
        const want = (blanks[i] || {}).answer || '';
        const ok = compareBlank(inp.value, want);
        return { ok, inp, want };
      });
      const correctCount = results.filter(r => r.ok).length;
      const total = blanks.length || 1;
      const allRight = correctCount === total;
      results.forEach(r => {
        r.inp.classList.add(r.ok ? 'correct' : 'wrong');
        if (r.ok && r.inp.value !== r.want) {
          // 70% prefix fill — also done in real time on input. We
          // only reach this branch when the student typed a shorter
          // answer that compareBlank accepted (e.g. numeric synonym
          // for a word answer) but the stored value still differs
          // from the canonical answer. Snap it to the canonical form
          // so the student sees the full word they got.
          r.inp.value = r.want;
        }
      });
      results.forEach((r, i) => {
        if (!r.ok) {
          const span = document.createElement('span');
          span.className = 'reveal-line';
          span.textContent = ` (${(blanks[i] || {}).answer})`;
          r.inp.insertAdjacentElement('afterend', span);
        }
      });
      showFeedback(rootEl,
        `${allRight ? '✓ All correct!' : `You got ${correctCount} of ${total} right.`}` +
        (d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''),
        allRight ? 'ok' : 'bad'
      );
      inputs.forEach(i => i.disabled = true);
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, correctCount, total);
    });
    reset.addEventListener('click', () => {
      inputs.forEach(i => {
        i.disabled = false; i.value = '';
        i.classList.remove('correct', 'wrong');
        // Clear the auto-fill state so the input is back to "empty,
        // untouched". Without this, the next typed character would
        // think the input is still in autofilled mode.
        delete i.dataset.autofilled;
        delete i.dataset.typedLen;
      });
      rootEl.querySelectorAll('.reveal-line').forEach(s => s.remove());
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  function bindMatch(rootEl, d, blockId, onScore) {
    const pairs = d.pairs || [];
    const leftBtns = rootEl.querySelectorAll('.match-tile[data-side="L"]');
    const rightBtns = rootEl.querySelectorAll('.match-tile[data-side="R"]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    let pL = null, pR = null;
    function clearSel() {
      [...leftBtns, ...rightBtns].forEach(x => x.classList.remove('selected'));
    }
    function pairUp() {
      if (!pL || !pR) return;
      const l = parseInt(pL.dataset.idx, 10);
      const r = parseInt(pR.dataset.idx, 10);
      pL.dataset.paired = String(r);
      pR.dataset.paired = String(l);
      clearSel();
      pL = null; pR = null;
    }
    leftBtns.forEach(b => b.addEventListener('click', () => {
      if (b.classList.contains('correct') || b.classList.contains('wrong')) return;
      leftBtns.forEach(x => x.classList.remove('selected'));
      b.classList.add('selected'); pL = b; pairUp();
    }));
    rightBtns.forEach(b => b.addEventListener('click', () => {
      if (b.classList.contains('correct') || b.classList.contains('wrong')) return;
      rightBtns.forEach(x => x.classList.remove('selected'));
      b.classList.add('selected'); pR = b; pairUp();
    }));
    check.addEventListener('click', () => {
      let correct = 0;
      leftBtns.forEach(lb => {
        const li = parseInt(lb.dataset.idx, 10);
        const ri = parseInt(lb.dataset.paired || '-1', 10);
        if (ri === li) { lb.classList.add('correct'); correct++; }
        else if (lb.dataset.paired !== undefined) lb.classList.add('wrong');
        else lb.classList.add('muted');
      });
      rightBtns.forEach(rb => {
        const ri = parseInt(rb.dataset.idx, 10);
        const li = parseInt(rb.dataset.paired || '-1', 10);
        if (li === ri) rb.classList.add('correct');
        else if (rb.dataset.paired !== undefined) rb.classList.add('wrong');
        else rb.classList.add('muted');
      });
      const allRight = correct === pairs.length && pairs.length > 0;
      showFeedback(rootEl, `${allRight ? '✓ All paired correctly!' : `You got ${correct} of ${pairs.length} right.`}`,
        allRight ? 'ok' : 'bad');
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, correct, pairs.length || 1);
    });
    reset.addEventListener('click', () => {
      [...leftBtns, ...rightBtns].forEach(b => {
        b.classList.remove('selected', 'correct', 'wrong', 'muted');
        delete b.dataset.paired;
      });
      pL = null; pR = null;
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  function bindOrdering(rootEl, d, blockId, onScore) {
    const list = rootEl.querySelector('[data-pbid="order-list"]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    let dragEl = null;
    list.querySelectorAll('.order-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        dragEl = item; item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.id);
      });
      item.addEventListener('dragend', () => { item.classList.remove('dragging'); dragEl = null; });
      item.addEventListener('dragover', (e) => { e.preventDefault(); });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragEl || dragEl === item) return;
        const rect = item.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        item.parentNode.insertBefore(dragEl, after ? item.nextSibling : item);
      });
    });
    check.addEventListener('click', () => {
      const items = [...list.querySelectorAll('.order-item')];
      const correct = (d.items || []).map(i => i.id);
      const given = items.map(it => it.dataset.id);
      const correctCount = given.filter((v, i) => v === correct[i]).length;
      const total = correct.length;
      const allRight = correctCount === total;
      items.forEach((it, i) => {
        it.classList.add(correct[i] === it.dataset.id ? 'correct-pos' : 'wrong-pos');
      });
      showFeedback(rootEl,
        `${allRight ? '✓ Correct order!' : `You got ${correctCount} of ${total} in the right place.`}` +
        (d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''),
        allRight ? 'ok' : 'bad');
      list.querySelectorAll('.order-item').forEach(i => i.setAttribute('draggable', 'false'));
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, correctCount, total);
    });
    reset.addEventListener('click', () => {
      const fresh = BLOCK_DEFS.ordering.render({ data: d });
      const tmp = document.createElement('div');
      tmp.innerHTML = fresh;
      list.innerHTML = tmp.querySelector('[data-pbid="order-list"]').innerHTML;
      bindOrdering(rootEl, d, blockId, onScore);
    });
  }

  // bindCategorise(rootEl, d, blockId, onScore) — student picks an item
  // tile, then a bucket, to assign the item. Each bucket collects the
  // item DOM nodes; the Check button compares each item's stored
  // data-correct against its assigned bucket's data-cat.
  function bindCategorise(rootEl, d, blockId, onScore) {
    const items = rootEl.querySelectorAll('[data-pbid="cat-items"] .cat-item');
    const buckets = rootEl.querySelectorAll('[data-pbid="cat-buckets"] .cat-bucket');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    const feedback = rootEl.querySelector('[data-pb="feedback"]');
    const itemPool = rootEl.querySelector('[data-pbid="cat-items"]');
    let active = null;
    function clearActive() { if (active) active.classList.remove('selected'); active = null; }
    items.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('correct') || btn.classList.contains('wrong')) return;
        if (active === btn) { clearActive(); return; }
        clearActive();
        active = btn; btn.classList.add('selected');
      });
    });
    buckets.forEach(b => {
      b.addEventListener('click', () => {
        if (b.classList.contains('correct') || b.classList.contains('wrong')) return;
        if (!active) return;
        const body = b.querySelector('.cat-bucket-body');
        active.classList.remove('selected');
        // Move the item into the bucket body.
        body.appendChild(active);
        active = null;
      });
    });
    check.addEventListener('click', () => {
      // Anything still in the item pool is unplaced — score as wrong.
      const placed = [...rootEl.querySelectorAll('.cat-item')];
      const inPool = [...itemPool.querySelectorAll('.cat-item')];
      if (!placed.length) { showFeedback(rootEl, 'Place each item into a category first.', 'info'); return; }
      let correct = 0;
      placed.forEach(btn => {
        const expected = parseInt(btn.dataset.correct, 10);
        const bucketEl = btn.closest('.cat-bucket');
        const got = bucketEl ? parseInt(bucketEl.dataset.cat, 10) : -1;
        btn.classList.remove('selected');
        if (got === expected) { btn.classList.add('correct'); correct++; }
        else { btn.classList.add('wrong'); }
      });
      inPool.forEach(btn => {
        if (!btn.classList.contains('correct') && !btn.classList.contains('wrong')) {
          btn.classList.add('wrong');
        }
      });
      buckets.forEach(b => {
        if (b.querySelector('.cat-item.correct')) b.classList.add('correct');
        else if (b.querySelector('.cat-item.wrong')) b.classList.add('wrong');
      });
      const total = items.length;
      const allRight = correct === total;
      showFeedback(rootEl,
        (allRight ? '✓ All sorted correctly!' : `You got ${correct} of ${total} in the right category.`),
        allRight ? 'ok' : 'bad'
      );
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, correct, total || 1);
    });
    reset.addEventListener('click', () => {
      // Re-render to put items back in the pool with fresh listeners.
      const fresh = renderCategorise({ data: d });
      const tmp = document.createElement('div');
      tmp.innerHTML = fresh;
      const newRoot = tmp.querySelector('[data-block-id]') || tmp.firstElementChild;
      // Replace in place.
      rootEl.innerHTML = newRoot ? newRoot.innerHTML : fresh;
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
      bindCategorise(rootEl, d, blockId, onScore);
    });
  }

  function bindHotspot(rootEl, d, blockId, onScore) {
    const wrap = rootEl.querySelector('[data-pbid="hs-wrap"]');
    if (!wrap) return;
    const img = wrap.querySelector('img');
    const dots = [...wrap.querySelectorAll('.dot')];
    const hs = d.hotspots || [];
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('.dot')) return;
      const rect = img.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top)  / rect.height) * 100;
      let best = -1, bestD = 6;
      hs.forEach((h, i) => {
        const dx = h.x - x, dy = h.y - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestD) { bestD = dist; best = i; }
      });
      dots.forEach((dot, i) => {
        dot.style.display = '';
        if (i === best && hs[i].correct) dot.style.background = 'var(--green-dim)';
        else if (i === best) dot.style.background = 'var(--red-dim)';
      });
      const correct = best >= 0 && hs[best].correct;
      const labels = hs.map((h, i) => `<div><b>${i + 1}.</b> ${escapeHtml(h.label || '')} ${h.correct ? '<span style="color:var(--green);">(correct)</span>' : ''}</div>`).join('');
      showFeedback(rootEl,
        (correct ? '✓ Correct!' : '✗ Not quite — here are the hotspots:') + `<div style="margin-top:6px;">${labels}</div>`,
        correct ? 'ok' : 'bad');
      if (onScore) onScore(blockId, correct ? 1.0 : 0.0, 1);
    });
  }

  // bindDenaryBinary — toggle bits, Check compares the built value
  // against the expected (denary -> zero-padded binary). Reset clears
  // the toggle state in place rather than re-rendering, which strips
  // the .practice wrapper (lesson-render.js itself doesn't have a
  // wrapper-safe reset helper) and would break the styling. The
  // in-place reset matches what bindMCQ / bindTrueFalse / bindShortAnswer
  // already do for this same reason.
  function bindDenaryBinary(rootEl, d, blockId, onScore) {
    const bitsWrap = rootEl.querySelector('[data-pbid="db-bits"]');
    if (!bitsWrap) return;
    const bitWidth = clampBitWidth(d.bitWidth);
    const denary = clampDenary(d.denary, bitWidth);
    const expected = expectedBits(denary, bitWidth);
    const bitButtons = [...bitsWrap.querySelectorAll('.db-bit')];
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    bitButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        // Locked once the student has Checked — Try-again resets.
        if (btn.classList.contains('correct') || btn.classList.contains('wrong')) return;
        const on = btn.getAttribute('aria-pressed') === 'true';
        const next = !on;
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        const valEl = btn.querySelector('.db-bit-val');
        if (valEl) valEl.textContent = next ? '1' : '0';
      });
    });
    check.addEventListener('click', () => {
      let total = 0;
      bitButtons.forEach(btn => {
        if (btn.getAttribute('aria-pressed') === 'true') {
          total += parseInt(btn.dataset.place, 10);
        }
      });
      const right = total === denary;
      bitButtons.forEach((btn, i) => {
        // expected[i] is the bit at position i (MSB first).
        const expectOn = expected[i] === '1';
        const gotOn = btn.getAttribute('aria-pressed') === 'true';
        if (expectOn) btn.classList.add('correct');
        else if (gotOn) btn.classList.add('wrong');
        // unset bits that match (expected 0, got 0) just stay neutral
      });
      showFeedback(rootEl,
        (right ? '✓ Correct!' : `✗ Not quite — the answer was <code>${escapeHtml(expected)}</code> (denary ${denary}).`) +
        (d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''),
        right ? 'ok' : 'bad');
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
    });
    reset.addEventListener('click', () => {
      bitButtons.forEach(btn => {
        btn.setAttribute('aria-pressed', 'false');
        btn.classList.remove('correct', 'wrong');
        const valEl = btn.querySelector('.db-bit-val');
        if (valEl) valEl.textContent = '0';
      });
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  // bindSlider — drag the handle to set a value. Live tolerance check
  // flashes the handle green when within tolerance. On Check, score is
  // binary (1.0 within tolerance, 0.0 otherwise).
  function bindSlider(rootEl, d, blockId, onScore) {
    const wrap = rootEl.querySelector('[data-pbid="slider-wrap"]');
    const handle = rootEl.querySelector('[data-pbid="slider-handle"]');
    const fill = rootEl.querySelector('[data-pbid="slider-fill"]');
    const tick = rootEl.querySelector('[data-pbid="slider-tick"]');
    const valueEl = rootEl.querySelector('[data-pbid="slider-value"]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    if (!wrap || !handle) return;
    const min = parseFloat(wrap.dataset.min);
    const max = parseFloat(wrap.dataset.max);
    const correct = parseFloat(wrap.dataset.correct);
    const tolerance = parseFloat(wrap.dataset.tolerance);
    const step = Number.isFinite(+d.step) && +d.step > 0 ? +d.step : 1;
    const range = max - min;
    let current = min + range / 2;
    // Show the correct zone as a faint band on the track.
    if (tick && tolerance > 0) {
      const lo = Math.max(min, correct - tolerance);
      const hi = Math.min(max, correct + tolerance);
      const loPct = ((lo - min) / range) * 100;
      const hiPct = ((hi - min) / range) * 100;
      tick.style.left = loPct + '%';
      tick.style.width = (hiPct - loPct) + '%';
      tick.style.opacity = '0.18';
    }
    function setValue(v, animated) {
      current = Math.max(min, Math.min(max, v));
      const snapped = Math.round(current / step) * step;
      current = Math.max(min, Math.min(max, snapped));
      const pct = ((current - min) / range) * 100;
      handle.style.left = pct + '%';
      fill.style.width = pct + '%';
      valueEl.textContent = current;
      handle.setAttribute('aria-valuenow', String(current));
      // Live tolerance feedback: green dot when in the band, neutral otherwise.
      const inBand = Math.abs(current - correct) <= tolerance;
      if (inBand) {
        handle.classList.add('slider-in-band');
        handle.classList.remove('slider-out-band');
      } else {
        handle.classList.remove('slider-in-band');
        handle.classList.add('slider-out-band');
      }
    }
    // Click on the track to jump the handle to that position.
    const track = rootEl.querySelector('[data-pbid="slider-track"]');
    track.addEventListener('click', (e) => {
      if (e.target === handle || handle.contains(e.target)) return;
      const rect = track.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      setValue(min + pct * range);
    });
    // Drag the handle.
    let dragging = false;
    function onMove(e) {
      if (!dragging) return;
      const rect = track.getBoundingClientRect();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const pct = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
      setValue(min + pct * range);
      e.preventDefault();
    }
    handle.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
    handle.addEventListener('touchstart', () => { dragging = true; }, { passive: true });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('touchend', () => { dragging = false; });
    // Keyboard accessibility.
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setValue(current - step); e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp')   { setValue(current + step); e.preventDefault(); }
    });
    // Initial value at centre.
    setValue(min + range / 2);
    // Check handler.
    check.addEventListener('click', () => {
      const right = Math.abs(current - correct) <= tolerance;
      handle.classList.remove('slider-in-band', 'slider-out-band');
      handle.classList.add(right ? 'correct' : 'wrong');
      fill.classList.add(right ? 'correct' : 'wrong');
      // Reveal the correct zone tick more strongly.
      if (tick) tick.style.opacity = '0.4';
      showFeedback(rootEl,
        `${right ? '✓ Correct!' : `✗ Not quite — the answer was ${correct}${d.unit || ''}.`}` +
        (d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''),
        right ? 'ok' : 'bad'
      );
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
    });
    reset.addEventListener('click', () => {
      handle.classList.remove('correct', 'wrong');
      fill.classList.remove('correct', 'wrong');
      if (tick) tick.style.opacity = '0.18';
      setValue(min + range / 2);
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  // bindDial — click-drag rotates an SVG needle. Snaps to `step`. On
  // Check, score is binary.
  function bindDial(rootEl, d, blockId, onScore) {
    const wrap = rootEl.querySelector('[data-pbid="dial-wrap"]');
    const svg = rootEl.querySelector('[data-pbid="dial-svg"]');
    const needle = rootEl.querySelector('[data-pbid="dial-needle"]');
    const valueEl = rootEl.querySelector('[data-pbid="dial-value"]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    if (!wrap || !needle) return;
    const min = parseFloat(wrap.dataset.min);
    const max = parseFloat(wrap.dataset.max);
    const correct = parseFloat(wrap.dataset.correct);
    const tolerance = parseFloat(wrap.dataset.tolerance);
    const step = parseFloat(wrap.dataset.step);
    const range = max - min;
    // Map a value to an angle: 0° (north) at min, going clockwise.
    // We render in SVG coords (y down), so the visual angle from north
    // is the value's fraction of the full sweep.
    function valToAngle(v) {
      const frac = (v - min) / range;
      return frac * 360; // degrees from north, clockwise
    }
    function setValue(v) {
      v = Math.max(min, Math.min(max, v));
      const snapped = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, snapped));
      const angle = valToAngle(v);
      // The needle starts pointing north (y2=30, x2=100). To rotate it
      // by `angle` degrees clockwise, we transform around the pivot
      // (100, 100). transform-origin in SVG is in user units when using
      // the transform attribute, but for CSS transforms we set it via
      // style.
      needle.style.transformOrigin = '100px 100px';
      needle.style.transform = `rotate(${angle}deg)`;
      valueEl.textContent = v;
    }
    // Draw tick marks at each step.
    const ticksG = svg.querySelector('.dial-ticks');
    if (ticksG) {
      const steps = Math.min(40, Math.ceil(range / step));
      let ticksHtml = '';
      for (let i = 0; i <= steps; i++) {
        const ang = (i / steps) * 360;
        const rad = (ang - 90) * Math.PI / 180;
        const x1 = 100 + Math.cos(rad) * 78;
        const y1 = 100 + Math.sin(rad) * 78;
        const x2 = 100 + Math.cos(rad) * 84;
        const y2 = 100 + Math.sin(rad) * 84;
        const major = (i % 5 === 0);
        ticksHtml += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--text-4)" stroke-width="${major ? 1.5 : 0.8}" />`;
      }
      ticksG.innerHTML = ticksHtml;
    }
    // Drag-to-rotate.
    let dragging = false;
    function angleFromEvent(e) {
      const rect = svg.getBoundingClientRect();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      const px = cx - (rect.left + rect.width / 2);
      const py = cy - (rect.top + rect.height / 2);
      // atan2 with y-down gives angle from east; we want from north,
      // clockwise. SVG points up at -y; our needle initially points to
      // (100, 30) which is north. So angle = atan2(px, -py) in degrees.
      let deg = Math.atan2(px, -py) * 180 / Math.PI;
      if (deg < 0) deg += 360;
      return deg;
    }
    function startDrag(e) { dragging = true; onMove(e); e.preventDefault(); }
    function endDrag() { dragging = false; }
    function onMove(e) {
      if (!dragging) return;
      const deg = angleFromEvent(e);
      setValue(min + (deg / 360) * range);
      e.preventDefault();
    }
    svg.addEventListener('mousedown', startDrag);
    svg.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('touchend', endDrag);
    // Initial value: 25% across the range (matches the render default).
    setValue(min + range * 0.25);
    check.addEventListener('click', () => {
      const current = parseFloat(valueEl.textContent);
      const right = Math.abs(current - correct) <= tolerance;
      needle.classList.remove('correct', 'wrong');
      needle.classList.add(right ? 'correct' : 'wrong');
      showFeedback(rootEl,
        `${right ? '✓ Correct!' : `✗ Not quite — the answer was ${correct}${d.unit || ''}.`}` +
        (d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''),
        right ? 'ok' : 'bad'
      );
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
    });
    reset.addEventListener('click', () => {
      needle.classList.remove('correct', 'wrong');
      setValue(min + range * 0.25);
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  // bindSequence — step-through with progress dots. Final score is the
  // fraction of inline inputs answered correctly.
  function bindSequence(rootEl, d, blockId, onScore) {
    const steps = [...rootEl.querySelectorAll('[data-pbid="seq-steps"] .seq-step')];
    const dots = [...rootEl.querySelectorAll('[data-pbid="seq-dots"] .seq-dot')];
    const prevBtn = rootEl.querySelector('[data-seq="prev"]');
    const nextBtn = rootEl.querySelector('[data-seq="next"]');
    const checkBtn = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    if (!steps.length || !prevBtn || !nextBtn || !checkBtn) return;
    let cur = 0;
    const stepDefs = d.steps || [];
    function show(i) {
      cur = Math.max(0, Math.min(steps.length - 1, i));
      steps.forEach((s, idx) => s.classList.toggle('active', idx === cur));
      dots.forEach((dot, idx) => {
        dot.classList.toggle('active', idx === cur);
        dot.classList.toggle('done', idx < cur);
      });
      prevBtn.hidden = (cur === 0);
      const isLast = (cur === steps.length - 1);
      nextBtn.hidden = isLast;
      checkBtn.hidden = !isLast;
    }
    prevBtn.addEventListener('click', () => show(cur - 1));
    nextBtn.addEventListener('click', () => {
      // Light feedback on advance.
      const dot = dots[cur];
      if (dot) {
        dot.classList.add('fx-pop');
        setTimeout(() => dot.classList.remove('fx-pop'), 300);
      }
      show(cur + 1);
    });
    // MCQ inside a step: single-select option.
    rootEl.querySelectorAll('.seq-mcq').forEach(mcq => {
      const opts = [...mcq.querySelectorAll('.opt')];
      opts.forEach(o => o.addEventListener('click', () => {
        if (o.classList.contains('correct') || o.classList.contains('wrong')) return;
        opts.forEach(x => x.classList.remove('selected'));
        o.classList.add('selected');
      }));
    });
    checkBtn.addEventListener('click', () => {
      let correct = 0, total = 0;
      stepDefs.forEach((s, i) => {
        const input = s.input;
        if (!input) return;
        if (input.type === 'text') {
          const el = rootEl.querySelector(`input[data-seq-input="i"][data-idx="${i}"]`);
          if (!el) return;
          total++;
          const got = normText(el.value);
          const answers = (input.answers || []).map(normText);
          if (got && answers.includes(got)) {
            el.classList.add('correct'); el.classList.remove('wrong'); correct++;
          } else {
            el.classList.add('wrong'); el.classList.remove('correct');
          }
          el.disabled = true;
        } else if (input.type === 'mcq') {
          const opts = [...rootEl.querySelectorAll(`[data-seq-mcq="${i}"] .opt`)];
          const sel = opts.find(o => o.classList.contains('selected'));
          if (!sel) return;
          total++;
          const expected = sel.dataset.correct === 'true';
          opts.forEach(o => {
            o.classList.remove('selected');
            if (o.dataset.correct === 'true') o.classList.add('correct');
            else if (o === sel) o.classList.add('wrong');
          });
          if (expected) correct++;
        }
      });
      // If no inputs at all, this is a free read-through — count as 1/1.
      if (total === 0) { correct = 1; total = 1; }
      const allRight = correct === total;
      showFeedback(rootEl,
        allRight ? '✓ Nice work — you\'ve worked through the steps.' : `You got ${correct} of ${total} correct.`,
        allRight ? 'ok' : 'bad'
      );
      checkBtn.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, correct, total);
    });
    reset.addEventListener('click', () => {
      steps.forEach(s => {
        s.querySelectorAll('.sa-input').forEach(el => {
          el.disabled = false; el.value = ''; el.classList.remove('correct', 'wrong');
        });
        s.querySelectorAll('.opt').forEach(o => o.classList.remove('selected', 'correct', 'wrong'));
      });
      show(0);
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
    show(0);
  }

  // bindConnect — click two endpoints to draw a line. Compare drawn
  // edges to the correct set on Check.
  function bindConnect(rootEl, d, blockId, onScore) {
    const wrap = rootEl.querySelector('[data-pbid="connect-wrap"]');
    const canvas = rootEl.querySelector('[data-pbid="connect-canvas"]');
    const svg = rootEl.querySelector('[data-pbid="connect-svg"]');
    const edgesG = rootEl.querySelector('[data-pbid="connect-edges"]');
    const countEl = rootEl.querySelector('[data-pbid="connect-count"]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    if (!wrap || !canvas || !svg || !edgesG) return;
    const points = d.points || [];
    const correctEdges = (d.edges || []).map(e => [e.from, e.to].sort().join('|'));
    let firstPick = null;
    let drawn = []; // [{a, b, el}]
    function getPos(id) {
      const btn = canvas.querySelector(`[data-pt="${CSS.escape(id)}"]`);
      if (!btn) return null;
      return { x: parseFloat(btn.style.left), y: parseFloat(btn.style.top) };
    }
    function setViewBox() {
      // Use the canvas's pixel size so the SVG matches the rendered layout.
      const r = canvas.getBoundingClientRect();
      svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    }
    setViewBox();
    // Redraw on resize so the SVG matches.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { setViewBox(); redraw(); }, 100);
    });
    function redraw() {
      edgesG.innerHTML = '';
      drawn.forEach(e => {
        const a = getPos(e.a), b = getPos(e.b);
        if (!a || !b) return;
        const w = canvas.getBoundingClientRect().width;
        const h = canvas.getBoundingClientRect().height;
        const ax = a.x / 100 * w, ay = a.y / 100 * h;
        const bx = b.x / 100 * w, by = b.y / 100 * h;
        const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('x1', ax); ln.setAttribute('y1', ay);
        ln.setAttribute('x2', bx); ln.setAttribute('y2', by);
        ln.setAttribute('class', 'connect-line ' + (e.el.getAttribute('class').includes('correct') ? 'correct' : e.el.getAttribute('class').includes('wrong') ? 'wrong' : ''));
        edgesG.appendChild(ln);
      });
    }
    canvas.querySelectorAll('.connect-pt').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('correct') || btn.classList.contains('wrong')) return;
        const id = btn.dataset.pt;
        if (!firstPick) {
          firstPick = id;
          btn.classList.add('selected');
          return;
        }
        if (firstPick === id) {
          // Toggle off.
          btn.classList.remove('selected');
          firstPick = null;
          return;
        }
        // Connect firstPick ↔ id.
        const a = firstPick, b = id;
        canvas.querySelectorAll('.connect-pt').forEach(p => p.classList.remove('selected'));
        firstPick = null;
        // Replace any existing edge that shares either endpoint.
        for (let i = drawn.length - 1; i >= 0; i--) {
          if (drawn[i].a === a || drawn[i].a === b || drawn[i].b === a || drawn[i].b === b) {
            drawn.splice(i, 1);
          }
        }
        drawn.push({ a, b, el: btn });
        if (countEl) countEl.textContent = String(drawn.length);
        // fx-pop on the second pick for satisfying feedback.
        btn.classList.add('fx-pop');
        setTimeout(() => btn.classList.remove('fx-pop'), 300);
        redraw();
      });
    });
    check.addEventListener('click', () => {
      if (!drawn.length) { showFeedback(rootEl, 'Draw at least one connection first.', 'info'); return; }
      const drawnSet = drawn.map(e => [e.a, e.b].sort().join('|'));
      let right = 0;
      drawnSet.forEach((k, i) => {
        const correct = correctEdges.includes(k);
        drawn[i].el.classList.add(correct ? 'correct' : 'wrong');
      });
      // For each correct edge not drawn, mark a ghost line.
      const drawnKeySet = new Set(drawnSet);
      const correctLines = correctEdges.filter(k => !drawnKeySet.has(k));
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      correctLines.forEach(k => {
        const [a, b] = k.split('|');
        const pa = getPos(a), pb = getPos(b);
        if (!pa || !pb) return;
        const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('x1', pa.x / 100 * w); ln.setAttribute('y1', pa.y / 100 * h);
        ln.setAttribute('x2', pb.x / 100 * w); ln.setAttribute('y2', pb.y / 100 * h);
        ln.setAttribute('class', 'connect-line ghost');
        edgesG.appendChild(ln);
      });
      // Score: correct drawn / max(drawn, correctEdges.length).
      const total = Math.max(drawnSet.length, correctEdges.length, 1);
      const matched = drawnSet.filter(k => correctEdges.includes(k)).length;
      right = matched;
      const allRight = matched === correctEdges.length && drawnSet.length === correctEdges.length;
      showFeedback(rootEl,
        allRight ? '✓ All connections correct!' : `You got ${right} connection${right === 1 ? '' : 's'} right.`,
        allRight ? 'ok' : 'bad'
      );
      // Lock the points from further interaction.
      canvas.querySelectorAll('.connect-pt').forEach(p => p.classList.add('correct', 'wrong'));
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, right, total);
    });
    reset.addEventListener('click', () => {
      drawn = [];
      firstPick = null;
      canvas.querySelectorAll('.connect-pt').forEach(p => p.classList.remove('selected', 'correct', 'wrong'));
      edgesG.innerHTML = '';
      if (countEl) countEl.textContent = '0';
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  // bindPile — drag items into Yes / No / Maybe buckets. Uses
  // HTML5 drag-and-drop for a familiar feel. On Check, score is the
  // fraction of items in the right bucket.
  function bindPile(rootEl, d, blockId, onScore) {
    const pool = rootEl.querySelector('[data-pbid="pile-pool"]');
    const buckets = rootEl.querySelectorAll('[data-bucket]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    if (!pool) return;
    // Make the pool a drop target too (so items can be moved back).
    function updateCounts() {
      buckets.forEach(b => {
        const cat = b.dataset.bucket;
        const count = b.querySelectorAll('.pile-item').length;
        const cEl = b.querySelector(`[data-count="${cat}"]`);
        if (cEl) cEl.textContent = String(count);
      });
    }
    function attachDragHandlers(item) {
      item.addEventListener('dragstart', (e) => {
        if (item.classList.contains('correct') || item.classList.contains('wrong')) { e.preventDefault(); return; }
        item.classList.add('dragging');
        e.dataTransfer.setData('text/plain', item.dataset.idx);
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
    }
    pool.querySelectorAll('.pile-item').forEach(attachDragHandlers);
    function bindDropTarget(target) {
      target.addEventListener('dragover', (e) => {
        if (target.classList.contains('correct') || target.classList.contains('wrong')) return;
        e.preventDefault();
        target.classList.add('dragover');
      });
      target.addEventListener('dragleave', () => target.classList.remove('dragover'));
      target.addEventListener('drop', (e) => {
        target.classList.remove('dragover');
        if (target.classList.contains('correct') || target.classList.contains('wrong')) return;
        e.preventDefault();
        const idx = e.dataTransfer.getData('text/plain');
        const item = pool.querySelector(`.pile-item[data-idx="${idx}"]`) || rootEl.querySelector(`.pile-item[data-idx="${idx}"]`);
        if (!item) return;
        // The drop target is either a bucket or the pool. Find the body
        // to insert into.
        const body = target.classList.contains('pile-bucket') ? target.querySelector('.pile-bucket-body') : target;
        body.appendChild(item);
        // fx-pop on landing.
        item.classList.remove('fx-pop');
        void item.offsetWidth;
        item.classList.add('fx-pop');
        setTimeout(() => item.classList.remove('fx-pop'), 300);
        updateCounts();
      });
    }
    buckets.forEach(bindDropTarget);
    bindDropTarget(pool);
    check.addEventListener('click', () => {
      const items = [...rootEl.querySelectorAll('.pile-item')];
      if (!items.length) return;
      let correct = 0;
      items.forEach(item => {
        const expected = item.dataset.correct;
        const bucket = item.closest('.pile-bucket');
        const got = bucket ? bucket.dataset.bucket : null;
        item.classList.remove('selected');
        if (got === expected) { item.classList.add('correct'); correct++; }
        else { item.classList.add('wrong'); }
      });
      const total = items.length;
      const allRight = correct === total;
      buckets.forEach(b => {
        if (b.querySelector('.pile-item.correct')) b.classList.add('correct');
        else if (b.querySelector('.pile-item.wrong')) b.classList.add('wrong');
      });
      showFeedback(rootEl,
        allRight ? '✓ All sorted correctly!' : `You got ${correct} of ${total} in the right pile.`,
        allRight ? 'ok' : 'bad'
      );
      check.disabled = true; reset.hidden = (d.allowRetry === false);
      if (onScore) onScore(blockId, correct, total);
    });
    reset.addEventListener('click', () => {
      const items = [...rootEl.querySelectorAll('.pile-item')];
      // Move all items back to the pool.
      const poolBody = rootEl.querySelector('[data-pbid="pile-pool"]');
      items.forEach(it => {
        it.classList.remove('correct', 'wrong', 'fx-pop');
        poolBody.appendChild(it);
      });
      buckets.forEach(b => b.classList.remove('correct', 'wrong', 'dragover'));
      updateCounts();
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  // wireFcDeck — handle the flashcard_stack study aid (no onScore).
  // State lives on the wrapper dataset; we update DOM on each action.
  function wireFcDeck(el) {
    if (!el) return;
    let cards;
    try { cards = JSON.parse(el.dataset.cards || '[]'); } catch (_) { cards = []; }
    if (!cards.length) return;
    let order = cards.map((_, i) => i);
    let pos = 0;
    let flipped = false;
    const stage = el.querySelector('[data-pbid="fcdeck-stage"]');
    const posEl = el.querySelector('[data-pbid="fcdeck-pos"]');
    const totalEl = el.querySelector('[data-pbid="fcdeck-total"]');
    const prev = el.querySelector('[data-fcdeck="prev"]');
    const next = el.querySelector('[data-fcdeck="next"]');
    const flip = el.querySelector('[data-fcdeck="flip"]');
    const shuffle = el.querySelector('[data-fcdeck="shuffle"]');
    function render() {
      const idx = order[pos];
      const c = cards[idx];
      stage.innerHTML = '';
      const front = document.createElement('div');
      front.className = 'fcdeck-card' + (flipped ? ' hidden' : '');
      front.setAttribute('data-side', 'front');
      front.textContent = (c && c.front) || '';
      const back = document.createElement('div');
      back.className = 'fcdeck-card back' + (flipped ? '' : ' hidden');
      back.setAttribute('data-side', 'back');
      back.textContent = (c && c.back) || '';
      stage.appendChild(front);
      stage.appendChild(back);
      // Animate the change.
      stage.classList.remove('fx-fade-up');
      void stage.offsetWidth;
      stage.classList.add('fx-fade-up');
      if (posEl) posEl.textContent = String(pos + 1);
      if (totalEl) totalEl.textContent = String(order.length);
      prev.disabled = false; next.disabled = false;
    }
    prev.addEventListener('click', () => { if (pos > 0) { pos--; flipped = false; render(); } });
    next.addEventListener('click', () => { if (pos < order.length - 1) { pos++; flipped = false; render(); } });
    flip.addEventListener('click', () => { flipped = !flipped; render(); });
    shuffle.addEventListener('click', () => {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      pos = 0; flipped = false; render();
    });
    render();
  }

  // wireProgMeter — confidence-rating checklist with a live progress
  // bar. Pure display, no scoring.
  function wireProgMeter(el) {
    if (!el) return;
    const fill = el.querySelector('[data-pbid="prog-meter-fill"]');
    const countEl = el.querySelector('[data-pbid="prog-meter-count"]');
    const rows = [...el.querySelectorAll('.prog-meter-row')];
    function update() {
      const total = rows.length;
      const got = el.querySelectorAll('.prog-meter-pill[data-state="got"].active').length;
      if (countEl) countEl.textContent = String(got);
      if (fill) fill.style.width = total ? (got / total * 100) + '%' : '0%';
    }
    rows.forEach(row => {
      const pills = [...row.querySelectorAll('.prog-meter-pill')];
      pills.forEach(pill => {
        pill.addEventListener('click', () => {
          pills.forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          row.dataset.state = pill.dataset.state;
          // Pulse the pill for satisfying feedback.
          pill.classList.remove('fx-pop');
          void pill.offsetWidth;
          pill.classList.add('fx-pop');
          setTimeout(() => pill.classList.remove('fx-pop'), 300);
          update();
        });
      });
    });
    update();
  }

  // wireMindMap — draw connecting lines from centre to branches on a
  // real DOM measurement. The renderer uses a viewBox of 0 0 100 100,
  // so the lines are placed in those user units.
  function wireMindMap(el) {
    if (!el) return;
    // No interactive behaviour needed for v1; the SVG is rendered
    // fully by BLOCK_DEFS.mindmap.render. Kept as a hook for future
    // interactive variants (e.g. click a branch to expand).
  }

  // wireFlashcardStudy — for flashcard blocks with `study: true`, show
  // the "Got it / Missed it" controls after the card is flipped. Tally
  // a running score in the corner. No onScore — this is a self-study
  // tool, not a graded exercise.
  function wireFlashcardStudy(rootEl) {
    const wrap = rootEl.querySelector('.flashcard-wrap');
    if (!wrap || wrap.dataset.fcstudyMode !== '1') return;
    const card = wrap.querySelector('.flashcard');
    const controls = wrap.querySelector('.flashcard-study');
    const result = wrap.querySelector('.flashcard-study-result');
    if (!card || !controls || !result) return;
    let got = 0, miss = 0;
    const updateResult = () => {
      result.hidden = false;
      const total = got + miss;
      const pct = total ? Math.round((got / total) * 100) : 0;
      result.textContent = `Score: ${got} / ${total} (${pct}%)`;
    };
    card.addEventListener('click', () => {
      // Show the study controls the first time the card is flipped.
      if (card.classList.contains('flipped')) {
        controls.hidden = false;
      } else {
        controls.hidden = true;
      }
    });
    controls.querySelectorAll('.fcstudy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.fcstudy === 'got') got++;
        else miss++;
        // Pop the button for satisfying feedback.
        btn.classList.remove('fx-pop');
        void btn.offsetWidth;
        btn.classList.add('fx-pop');
        setTimeout(() => btn.classList.remove('fx-pop'), 300);
        updateResult();
      });
    });
  }

  function bindTabs(rootEl, d) {
    const tabs = rootEl.querySelectorAll('[data-pbid="tabs-root"] .tab');
    const body = rootEl.querySelector('[data-pbid="tabs-root"] .tab-body');
    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const idx = parseInt(t.dataset.tab, 10);
      body.innerHTML = renderMarkdown((d.items || [])[idx].markdown || '');
    }));
  }

  // Master dispatch: called once per interactive block after the
  // HTML has been inserted into the DOM.
  function bindInteractive(rootEl, b, onScore) {
    if (!rootEl) return;
    const blockId = b.id;
    switch (b.kind) {
      case 'mcq':       bindMCQ(rootEl, b.data, blockId, onScore); break;
      case 'truefalse': bindTrueFalse(rootEl, b.data, blockId, onScore); break;
      case 'shortanswer': bindShortAnswer(rootEl, b.data, blockId, onScore); break;
      case 'fillblank': bindFillBlank(rootEl, b.data, blockId, onScore); break;
      case 'match':     bindMatch(rootEl, b.data, blockId, onScore); break;
      case 'ordering':  bindOrdering(rootEl, b.data, blockId, onScore); break;
      case 'hotspot':   bindHotspot(rootEl, b.data, blockId, onScore); break;
      case 'tabs':      bindTabs(rootEl, b.data); break;
      case 'categorise':bindCategorise(rootEl, b.data, blockId, onScore); break;
      case 'denary_binary': bindDenaryBinary(rootEl, b.data, blockId, onScore); break;
      // New interactive kinds (2026-07-24)
      case 'slider':    bindSlider(rootEl, b.data, blockId, onScore); break;
      case 'dial':      bindDial(rootEl, b.data, blockId, onScore); break;
      case 'sequence':  bindSequence(rootEl, b.data, blockId, onScore); break;
      case 'connect':   bindConnect(rootEl, b.data, blockId, onScore); break;
      case 'pile':      bindPile(rootEl, b.data, blockId, onScore); break;
      // Study aids (no onScore; just wire up any DOM-driven behaviour)
      case 'flashcard_stack': wireFcDeck(rootEl.querySelector('[data-pbid="fcdeck"]')); break;
      case 'progress_meter':  wireProgMeter(rootEl.querySelector('[data-pbid="prog-meter"]')); break;
      case 'mindmap':         wireMindMap(rootEl.querySelector('[data-pbid="mindmap"]')); break;
      case 'flashcard':       wireFlashcardStudy(rootEl); break;
      // 'html' is interactive but the interaction is a postMessage from
      // the sandboxed iframe to the parent (lesson.html), not a
      // bindInteractive call. See buildHtmlSrcdoc + lesson.html.
      case 'html':      break;
    }
  }

  // attachInteractivity(blocks, container, onScore)
  //   blocks:    the lesson_blocks rows
  //   container: the root element the blocks were rendered into
  //   onScore:   optional callback (blockId, score, total) => void
  //              called when an interactive block is checked. The
  //              student player uses this to build the per-block
  //              activity payload for the log_lesson_session RPC.
  function attachInteractivity(blocks, container, onScore) {
    blocks.forEach(b => {
      const rootEl = container.querySelector(`[data-block-id="${b.id}"]`);
      if (rootEl) bindInteractive(rootEl, b, onScore);
    });
  }

  // renderBlock(b, opts) — render one block to an HTML string and wrap
  // it in a data-block-id'd div so attachInteractivity can find it.
  // opts.container: if 'div', wraps in a <div> (the default, used by
  //   lesson.html). If 'inline', no wrapper (used by the staff
  //   preview, which renders blocks into a list and adds its own
  //   outer chrome).
  function renderBlock(b, opts) {
    opts = opts || {};
    const def = BLOCK_DEFS[b.kind];
    if (!def) return `<p style="color:var(--red)">[Unknown block: ${escapeHtml(b.kind)}]</p>`;
    const html = def.render(b);
    if (opts.container === 'inline') return html;
    // For block types whose renderer already returns a top-level .practice
    // wrapper (the interactive ones), put the data-block-id on that
    // wrapper so the listener attachment still works. For other types
    // wrap in a generic <div data-block-id>.
    if (html.startsWith('<div class="practice">') || html.startsWith('<div class="accordion">') || html.startsWith('<div class="tabs"')) {
      // Inject the data-block-id (and data-required for practice blocks —
      // the gating in lesson.html's isLessonCompletable reads both) on
      // the first outer div.
      const requiredAttr = (b.data && b.data.required) ? 'true' : 'false';
      return html.replace(
        /^<div /,
        `<div data-block-id="${escapeHtml(b.id)}" data-required="${requiredAttr}" `
      );
    }
    return `<div data-block-id="${escapeHtml(b.id)}">${html}</div>`;
  }

  // ---------- public exports ----------------------------------------------

  const api = {
    BLOCK_DEFS,
    renderMarkdown,
    escapeHtml,
    videoEmbedUrl,
    normText,
    renderBlock,
    attachInteractivity,
    bindInteractive,
  };

  // Expose both as a namespaced object (new style) and as legacy
  // globals (old staff.html code references BLOCK_DEFS and
  // bindInteractive directly).
  window.LessonRender = api;
  window.BLOCK_DEFS = BLOCK_DEFS;
  window.bindInteractive = bindInteractive;
})();
