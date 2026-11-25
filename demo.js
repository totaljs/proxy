'use strict';

const examples = {
  app: {
    file: 'Docker network',
    kind: 'Address',
    code: '# Use the service name and its internal port\nhttp://flow:8000',
    note: 'Proxy and Flow share a Docker network. Proxy reaches the app by its service name.'
  },
  domain: {
    file: 'routes.json',
    kind: 'JSON',
    code: '[\n  {\n    "id": "flow",\n    "hosts": ["flow.example.com"],\n    "target": "http://flow:8000",\n    "tls": "auto"\n  }\n]',
    note: 'Point your domain’s DNS record at the server and add the route. Then start Proxy with Docker Compose.'
  },
  https: {
    file: 'Public HTTPS',
    kind: 'URL',
    code: '# Open the app when the certificate is ready\nhttps://flow.example.com/',
    note: 'Proxy handles the Let’s Encrypt challenge and renews the certificate before it expires.'
  }
};

const steps = document.querySelectorAll('[data-step]');
for (const button of steps) {
  button.addEventListener('click', () => {
    const example = examples[button.dataset.step];
    for (const step of steps)
      step.setAttribute('aria-pressed', String(step === button));
    document.querySelector('#demo-file').textContent = example.file;
    document.querySelector('#demo-kind').textContent = example.kind;
    document.querySelector('#demo-code').textContent = example.code;
    document.querySelector('#demo-note').textContent = example.note;
  });
}

const copy = document.querySelector('#copy-command');
copy.addEventListener('click', async () => {
  const command = document.querySelector('#pull-command');
  const result = document.querySelector('#copy-result');
  try {
    await navigator.clipboard.writeText(command.textContent);
    copy.textContent = 'Copied';
    result.textContent = 'Docker command copied.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(command);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    result.textContent = 'The Docker command is selected. Copy it using your keyboard.';
  }
});
