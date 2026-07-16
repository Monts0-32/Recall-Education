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
      <div class="db-readout">
        <span class="db-readout-label">Your answer</span>
        <span class="db-readout-value" data-pbid="db-readout">0</span>
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
      defaults: () => ({ front: 'Photosynthesis', back: 'The process by which green plants use sunlight to synthesise food from CO₂ and water.' }),
      render: (b) => {
        return `<div class="flashcard" onclick="this.classList.toggle('flipped')">
          <div class="flashcard-inner">
            <div class="flashcard-face flashcard-front">${escapeHtml(b.data.front || '')}</div>
            <div class="flashcard-face flashcard-back">${escapeHtml(b.data.back || '')}</div>
          </div>
        </div>`;
      }
    },

    // Interactive practice
    mcq: { label: 'Multiple choice', defaults: () => ({ prompt: 'Which organelle is the powerhouse of the cell?', multi: false, options: [{ text: 'Nucleus', correct: false, feedback: 'The nucleus stores DNA, but it is not the energy producer.' }, { text: 'Mitochondrion', correct: true, feedback: 'Correct — mitochondria carry out aerobic respiration, producing ATP.' }, { text: 'Ribosome', correct: false, feedback: 'Ribosomes synthesise proteins, not ATP.' }, { text: 'Golgi apparatus', correct: false, feedback: 'The Golgi packages and ships proteins.' }], explanation: 'Mitochondria are often called the powerhouse of the cell because they generate most of the cell\'s ATP through aerobic respiration.' }), render: renderMCQ },
    truefalse: { label: 'True / False', defaults: () => ({ prompt: 'The Earth orbits the Sun once every 365.25 days.', answer: true, explanation: 'A sidereal year is approximately 365.256 days; the .25 is why we add a leap day every four years.' }), render: renderTrueFalse },
    shortanswer: { label: 'Short answer', defaults: () => ({ prompt: 'What is the chemical symbol for gold?', answers: ['Au', 'au'], explanation: 'Gold\'s symbol comes from its Latin name, *aurum*.' }), render: renderShortAnswer },
    fillblank: { label: 'Fill in the blank', defaults: () => ({ text: 'Photosynthesis converts carbon ___ and water into glucose and ___ using sunlight.', blanks: [{ answer: 'dioxide' }, { answer: 'oxygen' }], explanation: 'The general equation is 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂.' }), render: renderFillBlank },
    match: { label: 'Match pairs', defaults: () => ({ prompt: 'Match each scientist to their discovery.', pairs: [{ left: 'Newton', right: 'Laws of motion' }, { left: 'Darwin', right: 'Natural selection' }, { left: 'Mendel', right: 'Inheritance' }, { left: 'Curie', right: 'Radioactivity' }] }), render: renderMatch },
    ordering: { label: 'Order steps', defaults: () => ({ prompt: 'Put these steps of the scientific method in the correct order.', items: [{ id: 'a', text: 'Form a hypothesis' }, { id: 'b', text: 'Make an observation' }, { id: 'c', text: 'Analyse the data' }, { id: 'd', text: 'Draw a conclusion' }], explanation: 'A typical scientific method: observe → hypothesise → experiment → analyse → conclude.' }), render: renderOrdering },
    hotspot: { label: 'Image hotspot', defaults: () => ({ imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/640px-Cat03.jpg', alt: 'A cat', hotspots: [{ x: 50, y: 40, label: 'Ear', correct: true }, { x: 30, y: 70, label: 'Whiskers', correct: false }] }), render: renderHotspot },
    denary_binary: { label: 'Denary → binary', defaults: () => ({ prompt: 'Convert the following denary number to binary.', denary: 173, bitWidth: 8, explanation: '' }), render: renderDenaryBinary },

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
      ] }),
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
        if (d.multi) btn.classList.toggle('selected');
        else opts.forEach(o => o.classList.remove('selected'));
        btn.classList.add('selected');
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
      check.disabled = true; reset.hidden = false;
      if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
    });
    reset.addEventListener('click', () => {
      opts.forEach(o => o.classList.remove('selected', 'correct', 'wrong'));
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
  }

  function bindTrueFalse(rootEl, d, blockId, onScore) {
    const opts = rootEl.querySelectorAll('[data-pbid="tf-opts"] .opt');
    opts.forEach(btn => btn.addEventListener('click', () => {
      if (btn.classList.contains('correct') || btn.classList.contains('wrong')) return;
      opts.forEach(o => o.classList.remove('selected'));
      btn.classList.add('selected');
    }));
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
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
      showFeedback(rootEl, `${right ? '✓ Correct!' : '✗ Not quite.'}${d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''}`, right ? 'ok' : 'bad');
      check.disabled = true; reset.hidden = false;
      if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
    });
    reset.addEventListener('click', () => {
      opts.forEach(o => o.classList.remove('selected', 'correct', 'wrong'));
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
    });
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
      input.disabled = true; check.disabled = true; reset.hidden = false;
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
    check.addEventListener('click', () => {
      if (![...inputs].some(i => i.value)) { showFeedback(rootEl, 'Fill in the blanks first.', 'info'); return; }
      const results = [...inputs].map((inp, i) => ({
        ok: normText(inp.value) === normText((blanks[i] || {}).answer),
        input: inp
      }));
      const correctCount = results.filter(r => r.ok).length;
      const total = blanks.length || 1;
      const allRight = correctCount === total;
      results.forEach(r => r.input.classList.add(r.ok ? 'correct' : 'wrong'));
      results.forEach((r, i) => {
        if (!r.ok) {
          const ans = (blanks[i] || {}).answer;
          const span = document.createElement('span');
          span.className = 'reveal-line';
          span.textContent = ` (${ans})`;
          r.input.insertAdjacentElement('afterend', span);
        }
      });
      showFeedback(rootEl,
        `${allRight ? '✓ All correct!' : `You got ${correctCount} of ${total} right.`}` +
        (d.explanation ? `<div style="margin-top:6px;">${renderMarkdown(d.explanation)}</div>` : ''),
        allRight ? 'ok' : 'bad'
      );
      inputs.forEach(i => i.disabled = true);
      check.disabled = true; reset.hidden = false;
      if (onScore) onScore(blockId, correctCount, total);
    });
    reset.addEventListener('click', () => {
      inputs.forEach(i => { i.disabled = false; i.value = ''; i.classList.remove('correct', 'wrong'); });
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
      check.disabled = true; reset.hidden = false;
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
      check.disabled = true; reset.hidden = false;
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
      check.disabled = true; reset.hidden = false;
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

  // bindDenaryBinary — toggle bits, live numeric readout, Check compares
  // the built value against the expected (denary -> zero-padded binary).
  // Correctness is derived from the stored denary, so reset just re-renders
  // the block to clear the toggle state.
  function bindDenaryBinary(rootEl, d, blockId, onScore) {
    const bitsWrap = rootEl.querySelector('[data-pbid="db-bits"]');
    if (!bitsWrap) return;
    const bitWidth = clampBitWidth(d.bitWidth);
    const denary = clampDenary(d.denary, bitWidth);
    const expected = expectedBits(denary, bitWidth);
    const bitButtons = [...bitsWrap.querySelectorAll('.db-bit')];
    const readout = rootEl.querySelector('[data-pbid="db-readout"]');
    const check = rootEl.querySelector('[data-pb="check"]');
    const reset = rootEl.querySelector('[data-pb="reset"]');
    function recomputeReadout() {
      let total = 0;
      bitButtons.forEach(btn => {
        if (btn.getAttribute('aria-pressed') === 'true') {
          total += parseInt(btn.dataset.place, 10);
        }
      });
      if (readout) readout.textContent = String(total);
    }
    bitButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        // Locked once the student has Checked — Try-again resets.
        if (btn.classList.contains('correct') || btn.classList.contains('wrong')) return;
        const on = btn.getAttribute('aria-pressed') === 'true';
        const next = !on;
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        const valEl = btn.querySelector('.db-bit-val');
        if (valEl) valEl.textContent = next ? '1' : '0';
        recomputeReadout();
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
      check.disabled = true; reset.hidden = false;
      if (onScore) onScore(blockId, right ? 1.0 : 0.0, 1);
    });
    reset.addEventListener('click', () => {
      // Re-render the whole block to wipe toggle state and feedback.
      const fresh = renderDenaryBinary({ data: d });
      const tmp = document.createElement('div');
      tmp.innerHTML = fresh;
      const newRoot = tmp.querySelector('[data-block-id]') || tmp.firstElementChild;
      rootEl.innerHTML = newRoot ? newRoot.innerHTML : fresh;
      clearFeedback(rootEl); setCheckEnabled(rootEl, true);
      bindDenaryBinary(rootEl, d, blockId, onScore);
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
      // Inject the data-block-id on the first outer div.
      return html.replace(/^<div /, `<div data-block-id="${escapeHtml(b.id)}" `);
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
