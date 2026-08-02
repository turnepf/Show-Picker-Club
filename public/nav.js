/*
 * Shared navigation controller for all pages (home, member page, groups).
 * Manages back button labels and context across different page layouts.
 *
 * Each page defines window.navContext before loading this script:
 * {
 *   page: 'home' | 'member' | 'groups',
 *   backLabel: descriptive text for back button (e.g., 'Groups', 'Group Name')
 *   onBackClick?: custom handler for back button
 * }
 */

function initializeNav() {
  const ctx = window.navContext || {};
  const backLink = document.getElementById('backLink');

  if (!backLink) return;

  // Set back button label
  if (ctx.backLabel) {
    backLink.textContent = ctx.backLabel;
  }

  // Set back button click handler
  if (ctx.onBackClick) {
    backLink.onclick = (e) => {
      e.preventDefault();
      ctx.onBackClick();
      return false;
    };
  } else if (ctx.page === 'groups') {
    // Groups page: navigate via custom logic
    backLink.onclick = (e) => {
      e.preventDefault();
      if (window.navBack) window.navBack();
      return false;
    };
  } else {
    // Default: navigate to home
    backLink.href = '/';
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeNav);
} else {
  initializeNav();
}

// Export function to update nav context at runtime
window.updateNavLabel = function(label) {
  const backLink = document.getElementById('backLink');
  if (backLink) {
    backLink.textContent = label;
  }
};

window.updateNavContext = function(ctx) {
  if (ctx.backLabel) {
    window.updateNavLabel(ctx.backLabel);
  }
};
