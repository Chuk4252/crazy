// Crazy Downloader 2.1.0 Public Website Controller

window.CRAZY_SITE_CONFIG = {
  version: '2.1.0',
  executablePath: './Crazy%20Downloader%202.1.0.exe',
  executableName: 'Crazy Downloader 2.1.0.exe',
  executableSize: '122.53 MB',
  executableSha256: 'da3447e4b0641b26be0a32af1d8179ff3860f47bfe519d5ce357cdcf3dedf216',
  extensionFolderPath: './extensions/crazy-browser-ext',
  contactEmail: 'crazydownloadersport@gmail.com',
  customHeroGraphic: ''
};

(function initThemeImmediately() {
  try {
    const saved = localStorage.getItem('crazy_site_theme');
    const theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1. Theme Toggle
  const themeBtn = document.getElementById('theme-toggle');
  const updateThemeIcon = () => {
    if (!themeBtn) return;
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    themeBtn.setAttribute('aria-label', current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    const sunIcon = themeBtn.querySelector('.icon-sun');
    const moonIcon = themeBtn.querySelector('.icon-moon');
    if (sunIcon && moonIcon) {
      sunIcon.style.display = current === 'dark' ? 'block' : 'none';
      moonIcon.style.display = current === 'light' ? 'block' : 'none';
    }
  };
  updateThemeIcon();

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('crazy_site_theme', next);
      } catch {}
      updateThemeIcon();
    });
  }

  // 2. Mobile Menu Toggle with Staggered Link Entrance (60ms step, capped at 400ms)
  const menuToggle = document.getElementById('mobile-menu-toggle');
  const mobilePanel = document.getElementById('mobile-menu-panel');
  if (menuToggle && mobilePanel) {
    const mobileLinks = Array.from(mobilePanel.querySelectorAll('.mobile-nav-link'));
    mobileLinks.forEach((link, idx) => {
      const delayMs = Math.min(400, idx * 60);
      link.style.transitionDelay = `${delayMs}ms`;
    });

    menuToggle.addEventListener('click', () => {
      const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
      const nextState = !isOpen;
      menuToggle.setAttribute('aria-expanded', String(nextState));
      mobilePanel.classList.toggle('open', nextState);
    });

    mobileLinks.forEach((link) => {
      link.addEventListener('click', () => {
        menuToggle.setAttribute('aria-expanded', 'false');
        mobilePanel.classList.remove('open');
      });
    });
  }

  // 3. Populate Configurable Contact Email Slots
  const emailNodes = document.querySelectorAll('[data-contact-email]');
  emailNodes.forEach((node) => {
    const email = window.CRAZY_SITE_CONFIG.contactEmail;
    node.textContent = email;
    if (node.tagName === 'A' && !email.includes('{{')) {
      node.setAttribute('href', `mailto:${email}`);
    }
  });

  // 4. Scroll Reveal via IntersectionObserver (once per section, B7)
  const revealItems = document.querySelectorAll('.reveal-on-scroll');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealItems.forEach((el) => el.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14, rootMargin: '0px 0px -32px 0px' }
    );
    revealItems.forEach((el) => revealObserver.observe(el));
  }

  // 5. Mandatory Tagline Word-by-Word Reveal (B11)
  const taglineContainers = document.querySelectorAll('[data-tagline-reveal]');
  taglineContainers.forEach((container) => {
    const words = Array.from(container.querySelectorAll('.reveal-word'));
    if (words.length === 0) return;

    if (reducedMotion) {
      words.forEach((w) => w.classList.add('active'));
      return;
    }

    let ticking = false;
    const updateWords = () => {
      const rect = container.getBoundingClientRect();
      const viewH = window.innerHeight || document.documentElement.clientHeight;
      const startY = viewH * 0.82;
      const endY = viewH * 0.28;
      const progress = Math.max(0, Math.min(1, (startY - rect.top) / Math.max(1, startY - endY)));
      const activeCount = Math.round(progress * words.length);
      words.forEach((word, index) => {
        if (index < activeCount) {
          word.classList.add('active');
        }
      });
      ticking = false;
    };

    const requestTick = () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(updateWords);
      }
    };

    if ('IntersectionObserver' in window) {
      const taglineObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            requestTick();
            window.addEventListener('scroll', requestTick, { passive: true });
          } else {
            window.removeEventListener('scroll', requestTick);
          }
        });
      });
      taglineObserver.observe(container);
    }
    requestTick();
  });

  // 6. Interactive 3D Perspective Tilt (B7)
  if (!reducedMotion) {
    const tiltElements = document.querySelectorAll('[data-tilt-3d]');
    tiltElements.forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        const rotateY = (x * 7).toFixed(2);
        const rotateX = (-y * 7).toFixed(2);
        card.style.transform = `perspective(1200px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
      });
      card.addEventListener('pointerleave', () => {
        card.style.transform = 'perspective(1200px) rotateX(0deg) rotateY(0deg)';
      });
    });
  }

  // 7. Copy Utility Buttons
  const copyButtons = document.querySelectorAll('[data-copy-value]');
  copyButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const val = btn.getAttribute('data-copy-value') || '';
      const originalLabel = btn.getAttribute('data-original-label') || btn.textContent;
      btn.setAttribute('data-original-label', originalLabel);
      try {
        await navigator.clipboard.writeText(val);
        btn.textContent = 'Copied to clipboard';
        setTimeout(() => {
          btn.textContent = originalLabel;
        }, 2200);
      } catch {
        btn.textContent = 'Copy unavailable';
      }
    });
  });

  // 8. Client-side Contact Form Validation (B8, B9, B10)
  const contactForm = document.getElementById('contact-form');
  if (contactForm) {
    const statusBox = document.getElementById('contact-form-status');
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('contact-name');
      const emailInput = document.getElementById('contact-email');
      const topicInput = document.getElementById('contact-topic');
      const messageInput = document.getElementById('contact-message');

      const nameVal = (nameInput?.value || '').trim();
      const emailVal = (emailInput?.value || '').trim();
      const topicVal = (topicInput?.value || '').trim();
      const msgVal = (messageInput?.value || '').trim();

      if (!nameVal) {
        statusBox.className = 'form-msg error body-5';
        statusBox.textContent = 'Message not sent. Enter your name before submitting.';
        nameInput?.focus();
        return;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(emailVal)) {
        statusBox.className = 'form-msg error body-5';
        statusBox.textContent = 'Message not sent. Enter a valid email address such as alex@domain.com.';
        emailInput?.focus();
        return;
      }

      if (msgVal.length < 10) {
        statusBox.className = 'form-msg error body-5';
        statusBox.textContent = 'Message not sent. Include at least 10 characters describing your question or report.';
        messageInput?.focus();
        return;
      }

      const recipient = window.CRAZY_SITE_CONFIG.contactEmail;
      statusBox.className = 'form-msg success body-5';
      statusBox.textContent = `Message prepared for ${recipient} under topic "${topicVal}".`;

      if (!recipient.includes('{{')) {
        const subject = encodeURIComponent(`[Crazy Downloader 2.1.0] ${topicVal} from ${nameVal}`);
        const body = encodeURIComponent(`From: ${nameVal} (${emailVal})\n\n${msgVal}`);
        window.location.href = `mailto:${recipient}?subject=${subject}&body=${body}`;
      }
    });
  }
});

