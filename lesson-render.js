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
    }
  };

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
