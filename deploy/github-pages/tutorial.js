const request = document.getElementById('demo-request');
const review = document.getElementById('demo-review');
const result = document.getElementById('demo-result');

function show(step) {
  for (const panel of [request, review, result]) panel.hidden = panel !== step;
  step.querySelector('h2').focus();
}

function finish(accepted) {
  const source = document.getElementById(accepted ? 'suggested-text' : 'original-text');
  document.getElementById('result-text').textContent = source.textContent;
  document.getElementById('demo-status').textContent = accepted ? '제안을 반영했습니다.' : '제안을 거절했습니다. 원래 문장을 유지합니다.';
  show(result);
}

document.getElementById('show-proposal').addEventListener('click', () => show(review));
document.getElementById('apply-proposal').addEventListener('click', () => finish(true));
document.getElementById('reject-proposal').addEventListener('click', () => finish(false));
document.getElementById('restart-demo').addEventListener('click', () => show(request));
