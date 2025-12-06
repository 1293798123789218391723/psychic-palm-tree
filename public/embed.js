(function () {
    const form = document.getElementById('embedForm');
    const titleInput = document.getElementById('embedTitle');
    const descInput = document.getElementById('embedDescription');
    const urlInput = document.getElementById('embedUrl');
    const colorInput = document.getElementById('embedColor');
    const footerInput = document.getElementById('embedFooter');
    const imageInput = document.getElementById('embedImage');
    const thumbInput = document.getElementById('embedThumbnail');

    const preview = document.getElementById('embedPreview');
    const previewTitle = preview?.querySelector('.preview-title');
    const previewDesc = preview?.querySelector('.preview-description');
    const previewAuthor = preview?.querySelector('.preview-author');
    const previewFooter = preview?.querySelector('.preview-footer');
    const previewColor = preview?.querySelector('.color-bar');
    const previewImage = document.getElementById('previewImage');
    const previewThumb = document.getElementById('previewThumb');

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

    function updatePreview() {
        const embed = collectEmbed();
        if (previewTitle) {
            previewTitle.textContent = embed.title || 'Embed title';
            if (embed.url) {
                const link = document.createElement('a');
                link.href = embed.url;
                link.textContent = embed.title || 'Embed title';
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                previewTitle.innerHTML = '';
                previewTitle.appendChild(link);
            }
        }
        if (previewDesc) previewDesc.textContent = embed.description || 'Add some description to see it live here.';
        if (previewAuthor) {
            try {
                previewAuthor.textContent = embed.url ? new URL(embed.url).hostname : 'Embed Author';
            } catch (err) {
                previewAuthor.textContent = 'Embed Author';
            }
        }
        if (previewFooter) previewFooter.textContent = embed.footer || 'Footer';
        if (previewColor) previewColor.style.background = embed.color || '#5865f2';

        if (previewImage) {
            previewImage.src = embed.image;
            previewImage.style.display = embed.image ? 'block' : 'none';
        }
        if (previewThumb) {
            previewThumb.src = embed.thumbnail;
            previewThumb.style.display = embed.thumbnail ? 'block' : 'none';
        }
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
        document.body.appendChild(toast);
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
