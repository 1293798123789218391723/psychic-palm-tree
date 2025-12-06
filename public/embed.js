(function () {
    const form = document.getElementById('embedForm');
    const titleInput = document.getElementById('embedTitle');
    const descInput = document.getElementById('embedDescription');
    const urlInput = document.getElementById('embedUrl');
    const colorInput = document.getElementById('embedColor');
    const footerInput = document.getElementById('embedFooter');
    const imageInput = document.getElementById('embedImage');
    const thumbInput = document.getElementById('embedThumbnail');

    const previewPrimary = document.getElementById('embedPreview');
    const previewClone = document.getElementById('embedPreviewClone');

    const copyJsonBtn = document.getElementById('copyJson');
    const copyMarkdownBtn = document.getElementById('copyMarkdown');

    const storageKey = 'larpgod-embed-draft';

    function loadDraft() {
        try {
            const cached = localStorage.getItem(storageKey);
            if (!cached) return;
            const data = JSON.parse(cached);
            titleInput.value = data.title || '';
            descInput.value = data.description || '';
            urlInput.value = data.url || '';
            colorInput.value = data.color || '#5865f2';
            footerInput.value = data.footer || '';
            imageInput.value = data.image || '';
            thumbInput.value = data.thumbnail || '';
        } catch (err) {
            console.warn('draft load failed', err);
        }
    }

    function saveDraft() {
        try {
            const payload = collectEmbed();
            localStorage.setItem(storageKey, JSON.stringify(payload));
        } catch (err) {
            console.warn('draft save failed', err);
        }
    }

    function collectEmbed() {
        return {
            title: titleInput.value.trim(),
            description: descInput.value.trim(),
            url: urlInput.value.trim(),
            color: colorInput.value || '#5865f2',
            footer: footerInput.value.trim(),
            image: imageInput.value.trim(),
            thumbnail: thumbInput.value.trim(),
        };
    }

    function extractPreviewParts(container) {
        if (!container) return null;
        return {
            title: container.querySelector('.preview-title'),
            desc: container.querySelector('.preview-description'),
            author: container.querySelector('.preview-author'),
            footer: container.querySelector('.preview-footer'),
            color: container.querySelector('.color-bar'),
            image: container.querySelector('.preview-media img'),
            thumb: container.querySelector('.preview-thumb'),
        };
    }

    function updateSinglePreview(parts, embed) {
        if (!parts) return;
        if (parts.title) {
            parts.title.textContent = embed.title || 'Embed title';
            if (embed.url) {
                const link = document.createElement('a');
                link.href = embed.url;
                link.textContent = embed.title || 'Embed title';
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                parts.title.innerHTML = '';
                parts.title.appendChild(link);
            }
        }
        if (parts.desc) parts.desc.textContent = embed.description || 'Add some description to see it live here.';
        if (parts.author) {
            try {
                parts.author.textContent = embed.url ? new URL(embed.url).hostname : 'Embed Author';
            } catch (err) {
                parts.author.textContent = 'Embed Author';
            }
        }
        if (parts.footer) parts.footer.textContent = embed.footer || 'Footer';
        if (parts.color) parts.color.style.background = embed.color || '#5865f2';

        if (parts.image) {
            parts.image.src = embed.image;
            parts.image.style.display = embed.image ? 'block' : 'none';
        }
        if (parts.thumb) {
            parts.thumb.src = embed.thumbnail;
            parts.thumb.style.display = embed.thumbnail ? 'block' : 'none';
        }
    }

    function updatePreview() {
        const embed = collectEmbed();
        updateSinglePreview(extractPreviewParts(previewPrimary), embed);
        updateSinglePreview(extractPreviewParts(previewClone), embed);
    }

    async function copyToClipboard(text, label) {
        try {
            await navigator.clipboard.writeText(text);
            showToast(`${label} copied`);
        } catch (err) {
            console.error('copy failed', err);
            showToast('Copy failed', true);
        }
    }

    function showToast(message, error = false) {
        const toast = document.createElement('div');
        toast.className = `toast ${error ? 'error' : 'success'}`;
        toast.textContent = message;
        (document.getElementById('toastHost') || document.body).appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('visible'));
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 200);
        }, 2000);
    }

    function embedToDiscordJSON() {
        const e = collectEmbed();
        return JSON.stringify(
            {
                embeds: [
                    {
                        title: e.title || undefined,
                        description: e.description || undefined,
                        url: e.url || undefined,
                        color: parseInt((e.color || '#5865f2').replace('#', ''), 16),
                        image: e.image ? { url: e.image } : undefined,
                        thumbnail: e.thumbnail ? { url: e.thumbnail } : undefined,
                        footer: e.footer ? { text: e.footer } : undefined,
                    },
                ],
            },
            null,
            2
        );
    }

    function embedToMarkdown() {
        const e = collectEmbed();
        const link = e.url ? `[${e.title || 'embed link'}](${e.url})` : e.title || 'embed link';
        const desc = e.description ? `\n${e.description}` : '';
        return `${link}${desc}`;
    }

    function handleInput() {
        updatePreview();
        saveDraft();
    }

    function bindEvents() {
        form?.addEventListener('input', handleInput);
        copyJsonBtn?.addEventListener('click', () => copyToClipboard(embedToDiscordJSON(), 'JSON'));
        copyMarkdownBtn?.addEventListener('click', () => copyToClipboard(embedToMarkdown(), 'Markdown'));
    }

    loadDraft();
    updatePreview();
    bindEvents();
})();
