import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const loginBox = document.getElementById('login-box');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('email').value.trim();
  const pass = document.getElementById('password').value;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    loginError.textContent = 'Login failed — check email/password.';
  }
});

document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginBox.style.display = 'none';
    dashboard.style.display = 'block';
    initDashboard();
  } else {
    loginBox.style.display = 'block';
    dashboard.style.display = 'none';
  }
});

async function getTournamentConfig() {
  const snap = await getDoc(doc(db, 'config', 'tournament'));
  if (!snap.exists()) {
    const initial = { phase: 'submissions', title: 'Suggestion Tournament', currentRound: 0 };
    await setDoc(doc(db, 'config', 'tournament'), initial);
    return initial;
  }
  return snap.data();
}

async function initDashboard() {
  await refreshAll();
}

async function refreshAll() {
  const cfg = await getTournamentConfig();
  document.getElementById('title-input').value = cfg.title || '';
  document.getElementById('current-phase').textContent = cfg.phase;
  renderPhaseControls(cfg);
  await renderSuggestions();
  if (cfg.phase === 'voting' || cfg.phase === 'complete') {
    await renderBracketAdmin(cfg);
    document.getElementById('bracket-admin-section').style.display = 'block';
  } else {
    document.getElementById('bracket-admin-section').style.display = 'none';
  }
}

document.getElementById('save-title-btn').addEventListener('click', async () => {
  const title = document.getElementById('title-input').value.trim();
  await updateDoc(doc(db, 'config', 'tournament'), { title });
  flash('title-status', 'Saved.');
});

function renderPhaseControls(cfg) {
  const el = document.getElementById('phase-controls');
  el.innerHTML = '';
  if (cfg.phase === 'submissions') {
    el.innerHTML = `<button id="lock-btn">Lock submissions</button>`;
    document.getElementById('lock-btn').addEventListener('click', async () => {
      await updateDoc(doc(db, 'config', 'tournament'), { phase: 'locked' });
      refreshAll();
    });
  } else if (cfg.phase === 'locked') {
    el.innerHTML = `
      <button id="reopen-btn" class="secondary">Reopen submissions</button>
      <button id="generate-btn">Generate bracket from approved suggestions</button>
    `;
    document.getElementById('reopen-btn').addEventListener('click', async () => {
      await updateDoc(doc(db, 'config', 'tournament'), { phase: 'submissions' });
      refreshAll();
    });
    document.getElementById('generate-btn').addEventListener('click', generateBracket);
  } else if (cfg.phase === 'voting') {
    el.innerHTML = `<p class="subtext">Bracket in progress — manage rounds below.</p>`;
  } else if (cfg.phase === 'complete') {
    el.innerHTML = `
      <p class="subtext">Tournament complete.</p>
      <button id="reset-btn" class="secondary">Reset tournament</button>
    `;
    document.getElementById('reset-btn').addEventListener('click', resetTournament);
  }
}

async function renderSuggestions() {
  const snap = await getDocs(collection(db, 'suggestions'));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pending = all.filter(s => s.status === 'pending');
  const approved = all.filter(s => s.status === 'approved');
  const rejected = all.filter(s => s.status === 'rejected');

  const list = document.getElementById('suggestions-list');
  list.innerHTML = `
    <h3>Pending (${pending.length})</h3>
    ${pending.map(s => suggRow(s, ['approve', 'reject'])).join('') || '<p class="subtext">None.</p>'}
    <h3 style="margin-top:1.5rem;">Approved (${approved.length})</h3>
    ${approved.map(s => suggRow(s, ['reject'])).join('') || '<p class="subtext">None yet.</p>'}
    <h3 style="margin-top:1.5rem;">Rejected (${rejected.length})</h3>
    ${rejected.map(s => suggRow(s, ['approve'])).join('') || '<p class="subtext">None.</p>'}
  `;

  list.querySelectorAll('[data-approve]').forEach(btn => btn.addEventListener('click', async () => {
    await updateDoc(doc(db, 'suggestions', btn.dataset.approve), { status: 'approved' });
    refreshAll();
  }));
  list.querySelectorAll('[data-reject]').forEach(btn => btn.addEventListener('click', async () => {
    await updateDoc(doc(db, 'suggestions', btn.dataset.reject), { status: 'rejected' });
    refreshAll();
  }));
}

function suggRow(s, actions) {
  const btns = actions.map(a => {
    if (a === 'approve') return `<button data-approve="${s.id}">Approve</button>`;
    if (a === 'reject') return `<button class="reject" data-reject="${s.id}">Reject</button>`;
  }).join('');
  return `<div class="sugg-row">
    <span>${escapeHtml(s.text)} ${s.submitter ? `<span class="submitter">— ${escapeHtml(s.submitter)}</span>` : ''}</span>
    <span class="actions">${btns}</span>
  </div>`;
}

// ---- Bracket ----

async function generateBracket() {
  const snap = await getDocs(query(collection(db, 'suggestions'), where('status', '==', 'approved')));
  let entries = snap.docs.map(d => ({ id: d.id, text: d.data().text }));
  if (entries.length < 2) {
    alert('Approve at least 2 suggestions before generating a bracket.');
    return;
  }
  // shuffle
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  // pad to next power of two with byes
  let size = 1;
  while (size < entries.length) size *= 2;
  while (entries.length < size) entries.push({ id: 'bye', text: 'Bye' });

  const round0 = [];
  for (let i = 0; i < entries.length; i += 2) {
    const a = entries[i], b = entries[i + 1];
    const match = {
      id: `r0m${i / 2}`,
      aId: a.id, aText: a.text,
      bId: b.id, bText: b.text,
      winnerId: null
    };
    if (a.id === 'bye') match.winnerId = b.id;
    if (b.id === 'bye') match.winnerId = a.id;
    round0.push(match);
  }

  await setDoc(doc(db, 'config', 'bracket'), { rounds: [round0], currentRound: 0 });
  await updateDoc(doc(db, 'config', 'tournament'), { phase: 'voting', currentRound: 0 });
  refreshAll();
}

async function renderBracketAdmin(cfg) {
  const snap = await getDoc(doc(db, 'config', 'bracket'));
  if (!snap.exists()) return;
  const bracket = snap.data();
  const roundIdx = bracket.currentRound;
  const matches = bracket.rounds[roundIdx];

  const container = document.getElementById('bracket-admin-list');
  container.innerHTML = `<h3>Round ${roundIdx + 1} of ${Math.log2(bracket.rounds[0].length * 2)}</h3>`;

  for (const m of matches) {
    const rowEl = document.createElement('div');
    rowEl.className = 'sugg-row';
    rowEl.style.flexDirection = 'column';
    rowEl.style.alignItems = 'stretch';

    if (m.aId === 'bye' || m.bId === 'bye') {
      rowEl.innerHTML = `<strong>${escapeHtml(m.winnerId === m.aId ? m.aText : m.bText)}</strong> — auto-advanced (bye)`;
    } else {
      const counts = await getVoteCounts(m.id, m.aId, m.bId);
      rowEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;">
          <span>${escapeHtml(m.aText)} (${counts[m.aId] || 0} votes) vs ${escapeHtml(m.bText)} (${counts[m.bId] || 0} votes)</span>
          <span class="actions">
            ${m.winnerId
              ? `<strong>Winner: ${escapeHtml(m.winnerId === m.aId ? m.aText : m.bText)}</strong>`
              : `<button data-declare="${m.id}" data-winner="${m.aId}">${escapeHtml(m.aText)} wins</button>
                 <button data-declare="${m.id}" data-winner="${m.bId}">${escapeHtml(m.bText)} wins</button>`
            }
          </span>
        </div>
      `;
    }
    container.appendChild(rowEl);
  }

  container.querySelectorAll('[data-declare]').forEach(btn => btn.addEventListener('click', async () => {
    await declareWinner(bracket, roundIdx, btn.dataset.declare, btn.dataset.winner);
  }));

  const allDecided = matches.every(m => m.winnerId);
  const nextBtnWrap = document.getElementById('bracket-next-round-wrap');
  nextBtnWrap.innerHTML = '';
  if (allDecided) {
    if (matches.length === 1) {
      nextBtnWrap.innerHTML = `<button id="finish-btn">Finish tournament</button>`;
      document.getElementById('finish-btn').addEventListener('click', async () => {
        await updateDoc(doc(db, 'config', 'tournament'), { phase: 'complete' });
        refreshAll();
      });
    } else {
      nextBtnWrap.innerHTML = `<button id="next-round-btn">Generate next round</button>`;
      document.getElementById('next-round-btn').addEventListener('click', () => generateNextRound(bracket, roundIdx));
    }
  }
}

async function getVoteCounts(matchId, aId, bId) {
  const snap = await getDocs(query(collection(db, 'votes'), where('matchId', '==', matchId)));
  const counts = {};
  snap.docs.forEach(d => {
    const c = d.data().choice;
    counts[c] = (counts[c] || 0) + 1;
  });
  return counts;
}

async function declareWinner(bracket, roundIdx, matchId, winnerId) {
  const rounds = bracket.rounds;
  const match = rounds[roundIdx].find(m => m.id === matchId);
  match.winnerId = winnerId;
  await updateDoc(doc(db, 'config', 'bracket'), { rounds });
  refreshAll();
}

async function generateNextRound(bracket, roundIdx) {
  const currentMatches = bracket.rounds[roundIdx];
  const winners = currentMatches.map(m => ({
    id: m.winnerId,
    text: m.winnerId === m.aId ? m.aText : m.bText
  }));

  const nextRound = [];
  for (let i = 0; i < winners.length; i += 2) {
    const a = winners[i], b = winners[i + 1];
    nextRound.push({
      id: `r${roundIdx + 1}m${i / 2}`,
      aId: a.id, aText: a.text,
      bId: b.id, bText: b.text,
      winnerId: null
    });
  }

  const rounds = [...bracket.rounds, nextRound];
  await updateDoc(doc(db, 'config', 'bracket'), { rounds, currentRound: roundIdx + 1 });
  await updateDoc(doc(db, 'config', 'tournament'), { currentRound: roundIdx + 1 });
  refreshAll();
}

async function resetTournament() {
  if (!confirm('This clears the bracket and reopens submissions. Suggestions are kept. Continue?')) return;
  await deleteDoc(doc(db, 'config', 'bracket'));
  await updateDoc(doc(db, 'config', 'tournament'), { phase: 'submissions', currentRound: 0 });
  refreshAll();
}

function flash(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2000);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
