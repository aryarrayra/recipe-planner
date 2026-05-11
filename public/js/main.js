const chatWindow = document.getElementById('chatWindow');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const resetChat = document.getElementById('resetChat');

if (chatWindow && chatForm && chatInput) {
  const serverMessages = Array.isArray(window.__INITIAL_CHAT_MESSAGES__)
    ? window.__INITIAL_CHAT_MESSAGES__
    : [];

  const initialMessages = serverMessages.length
    ? serverMessages
    : [
        {
          role: 'ai',
          label: 'AI',
          text: 'Kirim bahan, budget, atau tujuan makan kamu. Saya akan bantu susun jawaban yang relevan untuk prototype ini.'
        }
      ];

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMessage(message) {
    const node = document.createElement('div');
    node.className = `msg ${message.role}`;

    const content = [];
    content.push(`<span class="meta">${escapeHtml(message.label)}</span>`);
    content.push(`<div>${escapeHtml(message.text).replace(/\n/g, '<br>')}</div>`);

    if (message.tips && message.tips.length) {
      content.push('<ul>' + message.tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join('') + '</ul>');
    }

    if (message.followUps && message.followUps.length) {
      content.push(
        '<div class="follow-ups">' +
          message.followUps.map((item) => `<button type="button" class="follow-up">${escapeHtml(item)}</button>`).join('') +
        '</div>'
      );
    }

    node.innerHTML = content.join('');
    chatWindow.appendChild(node);

    node.querySelectorAll('.follow-up').forEach((button) => {
      button.addEventListener('click', () => {
        chatInput.value = button.textContent;
        chatInput.focus();
      });
    });
  }

  function renderInitialState() {
    chatWindow.innerHTML = '';
    initialMessages.forEach(renderMessage);
  }

  async function clearChatHistory() {
    const response = await fetch('/api/chat/history', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Gagal menghapus histori chat');
    }

    return data;
  }

  async function sendMessage(message) {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Chat request failed');
    }

    return data.data;
  }

  chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const message = chatInput.value.trim();
    if (!message) return;

    renderMessage({ role: 'user', label: 'You', text: message });
    chatInput.value = '';

    const typingNode = document.createElement('div');
    typingNode.className = 'msg ai';
    typingNode.innerHTML = '<span class="meta">AI</span><div>Thinking...</div>';
    chatWindow.appendChild(typingNode);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    try {
      const result = await sendMessage(message);
      typingNode.remove();
      renderMessage({
        role: 'ai',
        label: result.aiTitle || 'AI',
        text: result.reply,
        tips: result.tips,
        followUps: result.followUps
      });
    } catch (error) {
      typingNode.remove();
      renderMessage({
        role: 'ai',
        label: 'AI',
        text: error.message || 'Terjadi error saat memproses chat.'
      });
    }

    chatWindow.scrollTop = chatWindow.scrollHeight;
  });

  resetChat?.addEventListener('click', async () => {
    const confirmed = window.confirm('Hapus histori chat untuk session ini?');
    if (!confirmed) return;

    try {
      await clearChatHistory();
      renderInitialState();
    } catch (error) {
      renderMessage({
        role: 'ai',
        label: 'AI',
        text: error.message || 'Terjadi error saat menghapus histori chat.'
      });
    }
  });
  renderInitialState();
}
