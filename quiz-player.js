// quiz-player.js
// ---------------------------------------------------------------------------
// Shared MCQ player used by homework.html for quiz-type assignments.
// The questions come from get_quiz_questions(p_assignment_id) which either
// returns inline quiz_data OR pulls mcq blocks from the linked Recall lesson.
//
// Usage:
//   const r = await window.QuizPlayer.load(assignmentId, supabaseClient);
//   if (r.ok) window.QuizPlayer.render(containerEl, r.questions, onChange);
//   const result = window.QuizPlayer.collect(containerEl);
//   const graded = await supabaseClient.rpc('grade_quiz', {
//     p_assignment_id: assignmentId, p_answers: result
//   });
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function load(assignmentId, supabaseClient) {
    const { data, error } = await supabaseClient.rpc('get_quiz_questions', {
      p_assignment_id: assignmentId,
    });
    if (error) return { ok: false, reason: error.message };
    if (!data || data.ok !== true) return { ok: false, reason: data && data.reason || 'unknown' };
    return {
      ok: true,
      source: data.source,
      lessonId: data.lesson_id,
      questions: data.questions || [],
    };
  }

  // Renders the questions into the container. Single-correct only for v1
  // (matches what the grader RPC scores against). Returns the array of
  // answer indices (initially all -1).
  function render(container, questions, onChange) {
    const answers = questions.map(() => -1);
    container.innerHTML = `
      <div class="quiz-list">${questions.map((q, i) => questionHtml(q, i)).join('')}</div>
    `;
    // Wire radio behaviour. Click anywhere on the option row to select.
    container.querySelectorAll('.quiz-q').forEach((qEl, i) => {
      const opts = qEl.querySelectorAll('.quiz-opt input[type="radio"]');
      opts.forEach((inp, j) => {
        inp.addEventListener('change', () => {
          if (inp.checked) {
            answers[i] = parseInt(inp.value, 10);
            if (typeof onChange === 'function') onChange(answers);
          }
        });
      });
      // Click on the label/row selects the radio.
      qEl.querySelectorAll('.quiz-opt').forEach((row, j) => {
        row.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          const r = row.querySelector('input[type="radio"]');
          if (r && !r.checked) {
            r.checked = true;
            r.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      });
    });
    return answers;
  }

  // After render, read the user's selections as a jsonb-shaped object:
  //   { "0": 2, "1": 0, "2": 1 }
  // -1 (no answer) is still sent so the grader can count it as wrong.
  function collect(container) {
    const out = {};
    container.querySelectorAll('.quiz-q').forEach((qEl, i) => {
      const checked = qEl.querySelector('input[type="radio"]:checked');
      out[i] = checked ? parseInt(checked.value, 10) : -1;
    });
    return out;
  }

  // Render a results panel (after grading). `perQuestion` is the array
  // returned by grade_quiz: [{ question_index, picked, correct }, ...].
  function renderResult(container, questions, score, perQuestion) {
    const html = questions.map((q, i) => {
      const pq = perQuestion[i] || {};
      const correct = !!pq.correct;
      const correctIdx = findCorrectIndex(q);
      return `
        <div class="quiz-q result ${correct ? 'is-correct' : 'is-wrong'}">
          <div class="quiz-q-head">
            <span class="quiz-q-num">Q${i + 1}</span>
            <span class="quiz-q-status">${correct ? '✓ Correct' : '✗ Wrong'}</span>
          </div>
          <div class="quiz-q-prompt">${escapeHtml(q.prompt)}</div>
          <div class="quiz-q-options">${(q.options || []).map((o, j) => `
            <div class="quiz-opt-static ${o.correct ? 'is-correct' : ''} ${j === pq.picked && !o.correct ? 'is-picked-wrong' : ''}">
              <span class="quiz-opt-letter">${String.fromCharCode(65 + j)}</span>
              <span>${escapeHtml(o.text)}</span>
            </div>
          `).join('')}</div>
          ${q.explanation ? `<div class="quiz-q-explain">${escapeHtml(q.explanation)}</div>` : ''}
        </div>
      `;
    }).join('');
    container.innerHTML = `
      <div class="quiz-result-head">
        <div class="quiz-score">${score}<small>%</small></div>
        <div class="quiz-score-label">${scoreLabel(score)}</div>
      </div>
      <div class="quiz-list">${html}</div>
    `;
  }

  function scoreLabel(s) {
    if (s >= 90) return 'Excellent';
    if (s >= 75) return 'Great work';
    if (s >= 60) return 'Good effort';
    if (s >= 40) return 'Keep practising';
    return 'Have another go';
  }

  function findCorrectIndex(q) {
    if (!q || !q.options) return -1;
    for (let i = 0; i < q.options.length; i++) {
      if (q.options[i].correct) return i;
    }
    return -1;
  }

  function questionHtml(q, i) {
    const opts = (q.options || []).map((o, j) => `
      <label class="quiz-opt">
        <input type="radio" name="q_${i}" value="${j}" />
        <span class="quiz-opt-letter">${String.fromCharCode(65 + j)}</span>
        <span class="quiz-opt-text">${escapeHtml(o.text)}</span>
      </label>
    `).join('');
    return `
      <div class="quiz-q" data-idx="${i}">
        <div class="quiz-q-head">
          <span class="quiz-q-num">Q${i + 1}</span>
        </div>
        <div class="quiz-q-prompt">${escapeHtml(q.prompt || '')}</div>
        <div class="quiz-q-options">${opts}</div>
      </div>
    `;
  }

  window.QuizPlayer = {
    load,
    render,
    collect,
    renderResult,
  };
})();
