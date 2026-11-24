/** Legacy WordPress paths → clean public paths. Longer prefixes first. */
export const PATH_REWRITES: [RegExp, string][] = [
  [/^\/wp-content\/uploads\/elementor\//i, "/assets/layout/"],
  [/^\/wp-content\/uploads\//i, "/media/"],
  [/^\/wp-content\/themes\/tortuga\//i, "/assets/site/"],
  [/^\/wp-content\/plugins\/simple-image-slider\//i, "/assets/slider/"],
  [/^\/wp-content\/plugins\/dropdown-menu-widget\//i, "/assets/nav/"],
  [/^\/wp-content\/plugins\/contact-form-7\/includes\/css\//i, "/assets/forms/"],
  [/^\/wp-content\/plugins\/essential-addons-for-elementor-lite\/assets\/front-end\/css\/view\//i, "/assets/addons/"],
  [/^\/wp-content\/plugins\/elementor\/assets\/css\//i, "/assets/layout/vendor/"],
  [/^\/wp-content\/plugins\/elementor\//i, "/assets/layout/vendor/"],
  [/^\/wp-content\/cache\/tw_optimize\/css\//i, "/assets/critical/"],
  [/^\/wp-content\/cache\//i, "/assets/critical/"],
  [/^\/wp-content\/fonts\//i, "/assets/fonts/"],
  [/^\/wp-includes\//i, "/assets/legacy/"],
];

export const STATIC_PREFIXES = ["/media/", "/assets/", "/wp-content/", "/wp-includes/", "/wp-admin/", "/wp-json/"];

export function rewritePublicPath(pathname: string) {
  let next = pathname;
  for (const [pattern, replacement] of PATH_REWRITES) {
    if (pattern.test(next)) {
      next = next.replace(pattern, replacement);
      break;
    }
  }
  return next;
}

export function isStaticPath(pathname: string) {
  return STATIC_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

export function isOptimizedImagePath(pathname: string) {
  return pathname.startsWith("/media/") || pathname.startsWith("/wp-content/uploads/");
}
