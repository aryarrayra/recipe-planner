const chatWindow = document.getElementById('chatWindow');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatPhoto = document.getElementById('chatPhoto');
const attachmentPreview = document.getElementById('attachmentPreview');
const attachmentPreviewImg = document.getElementById('attachmentPreviewImg');
const attachmentPreviewName = document.getElementById('attachmentPreviewName');
const removeAttachment = document.getElementById('removeAttachment');
const clearChat = document.getElementById('clearChat');
const sendButton = document.getElementById('sendButton');

if (chatWindow && chatForm && chatInput) {
  const serverMessages = Array.isArray(window.__INITIAL_CHAT_MESSAGES__)
    ? window.__INITIAL_CHAT_MESSAGES__
    : [];

  const starterMessage = {
    role: 'ai',
    label: 'AI',
    text: 'Kirim bahan, budget, tujuan makan, atau foto makanan. Enter untuk kirim, Shift+Enter untuk baris baru.',
    html: '<p>Kirim bahan, budget, tujuan makan, atau foto makanan. <strong>Enter</strong> untuk kirim, <strong>Shift+Enter</strong> untuk baris baru.</p>'
  };

  let attachmentFile = null;
  let isSending = false;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeHtml(html) {
    const allowedTags = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'UL', 'OL', 'LI', 'A']);
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const root = doc.body.firstElementChild;

    function sanitizeNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return document.createTextNode(node.textContent || '');
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return document.createTextNode('');
      }

      const tagName = node.tagName.toUpperCase();
      if (!allowedTags.has(tagName)) {
        const fragment = document.createDocumentFragment();
        node.childNodes.forEach((child) => {
          fragment.appendChild(sanitizeNode(child));
        });
        return fragment;
      }

      const clone = document.createElement(tagName.toLowerCase());

      node.childNodes.forEach((child) => {
        clone.appendChild(sanitizeNode(child));
      });

      return clone;
    }

    const wrapper = document.createElement('div');
    if (!root) {
      return '';
    }

    root.childNodes.forEach((child) => {
      wrapper.appendChild(sanitizeNode(child));
    });

    return wrapper.innerHTML;
  }

  function getComposerHtml() {
    return textToHtml(getComposerText());
  }

  function getComposerText() {
    return String(chatInput.value || '').replace(/\u00a0/g, ' ').trim();
  }

  function setComposerText(value) {
    chatInput.value = value || '';
  }

  function updateSendState() {
    const hasText = getComposerText().length > 0;
    const hasAttachment = Boolean(attachmentFile);
    sendButton.disabled = isSending || (!hasText && !hasAttachment);
  }

  function renderMessage(message) {
    const node = document.createElement('article');
    node.className = `chat-message ${message.role === 'ai' ? 'is-ai' : 'is-user'}`;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = message.label || (message.role === 'ai' ? 'AI' : 'You');
    bubble.appendChild(meta);

    if (message.attachment && message.attachment.dataUrl) {
      const figure = document.createElement('figure');
      figure.className = 'message-attachment';
      const image = document.createElement('img');
      image.src = message.attachment.dataUrl;
      image.alt = message.attachment.name || 'Foto terlampir';
      figure.appendChild(image);
      bubble.appendChild(figure);
    }

    const body = document.createElement('div');
    body.className = 'chat-body';
    body.innerHTML = sanitizeHtml(message.html || textToHtml(message.text || ''));
    bubble.appendChild(body);

    if (message.tips && message.tips.length) {
      const list = document.createElement('ul');
      list.className = 'chat-tips';
      message.tips.forEach((tip) => {
        const item = document.createElement('li');
        item.textContent = tip;
        list.appendChild(item);
      });
      bubble.appendChild(list);
    }

    if (message.followUps && message.followUps.length) {
      const wrap = document.createElement('div');
      wrap.className = 'chat-followups';
      message.followUps.forEach((followUp) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'follow-up';
        button.textContent = followUp;
        button.addEventListener('click', () => {
          setComposerText(followUp);
          chatInput.focus();
          updateSendState();
        });
        wrap.appendChild(button);
      });
      bubble.appendChild(wrap);
    }

    node.appendChild(bubble);
    chatWindow.appendChild(node);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  function textToHtml(value) {
    return escapeHtml(String(value || '')).replace(/\n/g, '<br>');
  }

  function renderInitialState() {
    chatWindow.innerHTML = '';
    const initialMessages = serverMessages.length ? serverMessages : [starterMessage];
    initialMessages.forEach(renderMessage);
    updateSendState();
  }

  function resetAttachment() {
    attachmentFile = null;
    if (chatPhoto) {
      chatPhoto.value = '';
    }
    if (attachmentPreview) {
      attachmentPreview.hidden = true;
    }
    if (attachmentPreviewImg) {
      attachmentPreviewImg.removeAttribute('src');
    }
    if (attachmentPreviewName) {
      attachmentPreviewName.textContent = 'Belum ada file';
    }
    updateSendState();
  }

  async function sendMessage(formData) {
    const response = await fetch('/api/chat', {
      method: 'POST',
      body: formData
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      window.location.href = '/login';
      return null;
    }

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Chat request failed');
    }

    return data.data;
  }

  chatInput.addEventListener('input', updateSendState);
  chatInput.addEventListener('paste', (event) => {
    const clipboardItems = Array.from(event.clipboardData?.items || []);
    const imageItem = clipboardItems.find((item) => item.kind === 'file' && item.type.startsWith('image/'));

    if (!imageItem) {
      window.requestAnimationFrame(updateSendState);
      return;
    }

    const file = imageItem.getAsFile();
    if (!file) {
      return;
    }

    event.preventDefault();
    attachmentFile = file;

    const reader = new FileReader();
    reader.onload = () => {
      if (attachmentPreviewImg) {
        attachmentPreviewImg.src = String(reader.result || '');
      }
      if (attachmentPreviewName) {
        attachmentPreviewName.textContent = file.name || 'clipboard-image.png';
      }
      if (attachmentPreview) {
        attachmentPreview.hidden = false;
      }
      updateSendState();
    };
    reader.readAsDataURL(file);
  });
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  document.querySelectorAll('.chat-quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const preset = chip.getAttribute('data-preset') || '';
      if (!preset) {
        return;
      }

      setComposerText(preset);
      chatInput.focus();
      updateSendState();
    });
  });

  chatPhoto?.addEventListener('change', () => {
    const file = chatPhoto.files && chatPhoto.files[0];
    attachmentFile = file || null;

    if (!file) {
      resetAttachment();
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (attachmentPreviewImg) {
        attachmentPreviewImg.src = String(reader.result || '');
      }
      if (attachmentPreviewName) {
        attachmentPreviewName.textContent = file.name;
      }
      if (attachmentPreview) {
        attachmentPreview.hidden = false;
      }
      updateSendState();
    };
    reader.readAsDataURL(file);
  });

  removeAttachment?.addEventListener('click', () => {
    resetAttachment();
  });

  chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const messageText = getComposerText();
    const messageHtml = getComposerHtml() || textToHtml(messageText);

    if (!messageText && !attachmentFile) {
      return;
    }

    const localMessage = {
      role: 'user',
      label: 'You',
      text: messageText || (attachmentFile ? `Foto terlampir: ${attachmentFile.name}` : ''),
      html: messageHtml,
      attachment: attachmentFile
        ? {
            name: attachmentFile.name,
            dataUrl: attachmentPreviewImg?.src || ''
          }
        : null
    };

    renderMessage(localMessage);

    const typingNode = document.createElement('article');
    typingNode.className = 'chat-message is-ai';
    typingNode.innerHTML = '<div class="chat-bubble"><div class="chat-meta">AI</div><div class="chat-body">Mengetik...</div></div>';
    chatWindow.appendChild(typingNode);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    isSending = true;
    updateSendState();

    const formData = new FormData();
    formData.append('messageText', messageText);
    formData.append('messageHtml', messageHtml);
    if (attachmentFile) {
      formData.append('photo', attachmentFile);
    }

    setComposerText('');
    resetAttachment();

    try {
      const result = await sendMessage(formData);
      if (!result) return;
      typingNode.remove();
      renderMessage({
        role: 'ai',
        label: result.aiTitle || 'AI',
        text: result.reply,
        html: result.html || textToHtml(result.reply),
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
    } finally {
      isSending = false;
      updateSendState();
      chatInput.focus();
    }
  });

  clearChat?.addEventListener('click', () => {
    const confirmed = window.confirm('Bersihkan tampilan chat ini tanpa menghapus history?');
    if (!confirmed) return;

    setComposerText('');
    resetAttachment();
    chatWindow.innerHTML = '';
    renderMessage(starterMessage);
  });

  renderInitialState();
  chatInput.focus();
}
