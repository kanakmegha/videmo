(async () => {
    const items = [];
    const elements = document.querySelectorAll('button, a, input, [role="button"], [role="link"], select, textarea');
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const centerX = viewportWidth / 2;
    const centerY = viewportHeight / 2;

    elements.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top <= viewportHeight) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                
                // --- UNIVERSAL GEOMETRIC SCORING ---
                let score = 5; // Base score
                
                const elCenterX = rect.left + rect.width / 2;
                const elCenterY = rect.top + rect.height / 2;
                
                // 1. Penalize 'Outer Edges'
                if (rect.top < viewportHeight * 0.15) score -= 5; // Header
                if (rect.bottom > viewportHeight * 0.90) score -= 5; // Footer

                // 2. Center Weight
                const isCentralX = elCenterX > viewportWidth * 0.2 && elCenterX < viewportWidth * 0.8;
                const isCentralY = elCenterY > viewportHeight * 0.2 && elCenterY < viewportHeight * 0.8;
                if (isCentralX && isCentralY) score += 5;

                // 3. Size Matters (Surface Area)
                const area = rect.width * rect.height;
                if (area > 10000) score += 2;
                if (area > 40000) score += 3;

                // 4. Semantic Role/Density
                const tag = el.tagName.toLowerCase();
                const role = el.getAttribute('role');
                const ariaText = (el.getAttribute('aria-label') || el.title || el.placeholder || '').toLowerCase();
                const innerText = el.innerText.toLowerCase();
                const keywords = ['start', 'create', 'generate', 'try', 'get started', 'record', 'live', 'submit'];
                
                if (keywords.some(kw => ariaText.includes(kw) || innerText.includes(kw))) {
                    score += 5;
                }

                const id = `ag-${i}`;
                el.setAttribute('data-antigravity-id', id);
                
                items.push({
                    "id": id,
                    "name": (el.innerText || el.value || el.placeholder || el.title || el.getAttribute('aria-label') || "unnamed").substring(0, 50).trim(),
                    "role": role || tag,
                    "aria_label": el.getAttribute('aria-label') || "",
                    "title": el.title || "",
                    "alt": el.getAttribute('alt') || "",
                    "x": elCenterX,
                    "y": elCenterY,
                    "impact_score": Math.max(1, Math.min(10, score)),
                    "rect": { "top": rect.top, "bottom": rect.bottom, "left": rect.left, "right": rect.right }
                });
            }
        }
    });
    return items;
})();
