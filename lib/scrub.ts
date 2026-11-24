function readAttrSafe(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2];
}

/** Longest-first token renames so WordPress/Elementor footprints leave served HTML/CSS. */
const CLASS_RENAMES: [RegExp, string][] = [
  [/^menu-item-object-page$/, ""],
  [/^menu-item-object-custom$/, ""],
  [/^menu-item-type-post_type$/, ""],
  [/^menu-item-type-custom$/, ""],
  [/^menu-item-has-children$/, "nav-has-children"],
  [/^menu-item-home$/, "nav-item-home"],
  [/^menu-item-(\d+)$/, "nav-item-$1"],
  [/^menu-item$/, "nav-item"],
  [/^page_item_has_children$/, "nav-has-children"],
  [/^page_item$/, "nav-item"],
  [/^current-menu-item$/, "nav-current"],
  [/^current_page_item$/, "nav-current"],
  [/^current-menu-ancestor$/, "nav-ancestor"],
  [/^current-menu-parent$/, "nav-parent"],
  [/^elementor-kit-(\d+)$/, "ui-kit-$1"],
  [/^elementor-page-(\d+)$/, "ui-page-$1"],
  [/^elementor-invisible$/, "ui-reveal"],
  [/^elementor-widget-container$/, "ui-widget-box"],
  [/^elementor-widget-(.+)$/, "ui-widget-$1"],
  [/^elementor-element-(.+)$/, "ui-el-$1"],
  [/^elementor-element$/, "ui-el"],
  [/^elementor-heading-title$/, "ui-heading"],
  [/^elementor-size-(.+)$/, "ui-size-$1"],
  [/^elementor-section$/, "ui-section"],
  [/^elementor-container$/, "ui-container"],
  [/^elementor-column$/, "ui-column"],
  [/^elementor-default$/, ""],
  [/^elementor-(.+)$/, "ui-$1"],
  [/^elementor$/, "ui-root"],
  [/^e-con-inner$/, "ui-inner"],
  [/^e-con$/, "ui-section"],
  [/^eael-/, "ux-"],
  [/^wpcf7-?/, "form-"],
  [/^wp-image-(\d+)$/, "media-$1"],
  [/^wp-block-(\w+)$/, "block-$1"],
  [/^wp-embed-responsive$/, ""],
  [/^wp-singular$/, ""],
  [/^wp-theme-tortuga$/, ""],
  [/^wp-custom-logo$/, "brand-logo"],
  [/^has-post-thumbnail$/, "has-thumb"],
  [/^page-template-default$/, ""],
  [/^page-id-(\d+)$/, ""],
  [/^postid-(\d+)$/, ""],
  [/^post-(\d+)$/, ""],
  [/^page$/, "is-page"],
  [/^post-layout-two-columns$/, "layout-two-col"],
  [/^post-layout-columns$/, "layout-cols"],
  [/^custom-background$/, ""],
  [/^sis-slider-wrapper$/, "slider-wrap"],
  [/^sis-slider$/, "slider"],
  [/^sis-slide$/, "slider-slide"],
  [/^sis-dots$/, "slider-dots"],
  [/^sis-dot$/, "slider-dot"],
  [/^sis-active$/, "slider-active"],
  [/^sis-arrow$/, "slider-arrow"],
  [/^sis-prev$/, "slider-prev"],
  [/^sis-next$/, "slider-next"],
  [/^primary-navigation-wrap$/, "site-nav-wrap"],
  [/^main-navigation-menu$/, "site-nav-menu"],
  [/^main-navigation$/, "site-nav"],
  [/^top-navigation$/, "utility-nav"],
  [/^primary-menu-toggle$/, "nav-toggle"],
  [/^menu-toggle$/, "nav-toggle"],
  [/^site-header$/, "brand-header"],
  [/^site-branding$/, "brand-block"],
  [/^site-title$/, "brand-title"],
  [/^site-description$/, "brand-tagline"],
  [/^site-content$/, "main-content"],
  [/^site-main$/, "main-column"],
  [/^site-info$/, "footer-info"],
  [/^site-footer$/, "page-footer"],
  [/^entry-content$/, "post-body"],
  [/^entry-header$/, "post-header"],
  [/^entry-title$/, "post-title"],
  [/^page-title$/, "post-title"],
  [/^widget-area$/, "side-panel"],
  [/^widget-wrap$/, "panel-wrap"],
  [/^widget-header$/, "panel-header"],
  [/^widget-title$/, "panel-title"],
  [/^footer-widgets-wrap$/, "footer-panels"],
  [/^footer-wrap$/, "footer-bar"],
  [/^tortuga-/, "site-"],
  [/^wp-(.+)$/, "ui-$1"],
];

const ID_RENAMES: [RegExp, string][] = [
  [/^masthead$/, "brand-bar"],
  [/^site-navigation$/, "primary-nav"],
  [/^site-header$/, "brand-header"],
  [/^colophon$/, "page-footer"],
  [/^wp-custom-css$/, "site-custom-css"],
  [/^menu-item-(\d+)$/, "nav-item-$1"],
  [/^sis-slider-(.+)$/, "slider-$1"],
  [/^simple-image-slider-js$/, "site-slider-js"],
  [/^simple-image-slider-css$/, "site-slider-css"],
];

const CSS_TOKEN_RENAMES: [RegExp, string][] = [
  [/\.sis-slider-wrapper\b/g, ".slider-wrap"],
  [/\.sis-slider\b/g, ".slider"],
  [/\.sis-slide\b/g, ".slider-slide"],
  [/\.sis-dots\b/g, ".slider-dots"],
  [/\.sis-dot\b/g, ".slider-dot"],
  [/\.sis-active\b/g, ".slider-active"],
  [/\.sis-arrow\b/g, ".slider-arrow"],
  [/\.sis-prev\b/g, ".slider-prev"],
  [/\.sis-next\b/g, ".slider-next"],
  [/\.elementor-invisible\b/g, ".ui-reveal"],
  [/\.elementor-widget-container\b/g, ".ui-widget-box"],
  [/\.elementor-heading-title\b/g, ".ui-heading"],
  [/\.elementor-element\b/g, ".ui-el"],
  [/\.elementor-widget-/g, ".ui-widget-"],
  [/\.elementor-element-/g, ".ui-el-"],
  [/\.elementor-size-/g, ".ui-size-"],
  [/\.elementor-/g, ".ui-"],
  [/\.elementor(?![\w-])/g, ".ui-root"],
  [/\.e-con-inner\b/g, ".ui-inner"],
  [/\.e-con\b/g, ".ui-section"],
  [/\.eael-/g, ".ux-"],
  [/\.wpcf7/g, ".form"],
  [/\.wp-image-/g, ".media-"],
  [/\.menu-item-has-children\b/g, ".nav-has-children"],
  [/\.menu-item-/g, ".nav-item-"],
  [/\.menu-item\b/g, ".nav-item"],
  [/\.page_item_has_children\b/g, ".nav-has-children"],
  [/\.current-menu-item\b/g, ".nav-current"],
  [/\.current_page_item\b/g, ".nav-current"],
  [/\.primary-navigation-wrap\b/g, ".site-nav-wrap"],
  [/\.main-navigation-menu\b/g, ".site-nav-menu"],
  [/\.main-navigation\b/g, ".site-nav"],
  [/\.top-navigation\b/g, ".utility-nav"],
  [/\.menu-toggle\b/g, ".nav-toggle"],
  [/\.primary-menu-toggle\b/g, ".nav-toggle"],
  [/\.site-header\b/g, ".brand-header"],
  [/\.site-branding\b/g, ".brand-block"],
  [/\.site-title\b/g, ".brand-title"],
  [/\.site-description\b/g, ".brand-tagline"],
  [/\.site-content\b/g, ".main-content"],
  [/\.site-main\b/g, ".main-column"],
  [/\.site-info\b/g, ".footer-info"],
  [/\.site-footer\b/g, ".page-footer"],
  [/\.entry-content\b/g, ".post-body"],
  [/\.entry-header\b/g, ".post-header"],
  [/\.entry-title\b/g, ".post-title"],
  [/\.page-title\b/g, ".post-title"],
  [/\.page(?![\w-])/g, ".is-page"],
  [/\.widget-area\b/g, ".side-panel"],
  [/\.widget-wrap\b/g, ".panel-wrap"],
  [/\.widget-header\b/g, ".panel-header"],
  [/\.widget-title\b/g, ".panel-title"],
  [/\.footer-widgets-wrap\b/g, ".footer-panels"],
  [/\.footer-wrap\b/g, ".footer-bar"],
  [/#masthead\b/g, "#brand-bar"],
  [/#site-navigation\b/g, "#primary-nav"],
  [/#wp-custom-css\b/g, "#site-custom-css"],
  [/#sis-slider-/g, "#slider-"],
];

function renameClassToken(token: string) {
  let next = token;
  for (const [pattern, replacement] of CLASS_RENAMES) {
    if (pattern.test(next)) {
      next = next.replace(pattern, replacement);
      break;
    }
  }
  return next;
}

function renameIdToken(token: string) {
  let next = token;
  for (const [pattern, replacement] of ID_RENAMES) {
    if (pattern.test(next)) {
      next = next.replace(pattern, replacement);
      break;
    }
  }
  return next;
}

function rewriteClassAttr(value: string) {
  return value
    .split(/\s+/)
    .map((token) => renameClassToken(token))
    .filter(Boolean)
    .join(" ");
}

export function scrubCss(css: string) {
  let next = css;
  for (const [pattern, replacement] of CSS_TOKEN_RENAMES) {
    next = next.replace(pattern, replacement);
  }
  next = next.replace(/\.wp-[\w-]+/g, (match) => {
    const renamed = renameClassToken(match.slice(1));
    return renamed ? `.${renamed}` : match;
  });
  next = next.replace(/--wp--/g, "--ui--");
  next = next.replace(/--wp-/g, "--ui-");
  next = next.replace(/\/wp-content\/uploads\/elementor\//gi, "/assets/layout/");
  next = next.replace(/\/wp-content\/uploads\//gi, "/media/");
  next = next.replace(/\/wp-content\/themes\/tortuga\//gi, "/assets/site/");
  next = next.replace(/\/wp-includes\//gi, "/assets/legacy/");
  return next;
}

export function scrubHtmlFootprints(html: string) {
  let next = html;

  next = next.replace(/<!--\s*This site is optimized with the Yoast SEO plugin[\s\S]*?-->/gi, "");
  next = next.replace(/<!--\s*\/\s*Yoast SEO plugin\s*-->/gi, "");
  next = next.replace(/<!--\s*HFCM by 99 Robots[\s\S]*?-->/gi, "");
  next = next.replace(/<!--\s*\/end HFCM by 99 Robots\s*-->/gi, "");
  next = next.replace(/<!--\s*Mirrored from[\s\S]*?-->/gi, "");
  next = next.replace(/<meta\b[^>]*name=(["'])generator\1[^>]*>/gi, "");
  next = next.replace(/<link\b[^>]*rel=(["'])(?:EditURI|wlwmanifest|https:\/\/api\.w\.org\/|shortlink)\1[^>]*>/gi, "");
  next = next.replace(/<link\b[^>]*rel=(["'])alternate\1[^>]*>/gi, (tag) => {
    const type = (readAttrSafe(tag, "type") || "").toLowerCase();
    const href = readAttrSafe(tag, "href") || "";
    if (/oembed/i.test(type) || /wp-json|xmlrpc/i.test(href)) return "";
    return tag;
  });
  next = next.replace(/<link\b[^>]*href=(["'])[^"']*(?:xmlrpc|wp-json)[^"']*\1[^>]*>/gi, "");
  next = next.replace(/<style\b[^>]*id=(["'])(?:wp-emoji-styles-inline-css|wp-block-library-inline-css|wp-img-auto-sizes-contain-inline-css|global-styles-inline-css|classic-theme-styles-inline-css)\1[^>]*>[\s\S]*?<\/style>/gi, "");
  next = next.replace(/href=(["'])[^"']*wp-login[^"']*\1/gi, 'href="/"');
  next = next.replace(/\sdata-elementor-[\w-]+=(["'])[\s\S]*?\1/gi, "");
  next = next.replace(/\sdata-element_type=(["'])[\s\S]*?\1/gi, "");
  next = next.replace(/\sdata-widget_type=(["'])[\s\S]*?\1/gi, "");
  next = next.replace(/\sdata-id=(["'])[a-f0-9]+\1/gi, "");
  next = next.replace(/\sdata-eael-[\w-]+=(["'])[\s\S]*?\1/gi, "");

  next = next.replace(/(\sclass\s*=\s*)(["'])([\s\S]*?)\2/gi, (_m, prefix: string, quote: string, value: string) => {
    return `${prefix}${quote}${rewriteClassAttr(value)}${quote}`;
  });

  next = next.replace(/(\sid\s*=\s*)(["'])([\s\S]*?)\2/gi, (_m, prefix: string, quote: string, value: string) => {
    return `${prefix}${quote}${renameIdToken(value)}${quote}`;
  });

  next = next.replace(/(\s(?:for|aria-labelledby|aria-describedby|aria-controls)\s*=\s*)(["'])([\s\S]*?)\2/gi, (_m, prefix: string, quote: string, value: string) => {
    return `${prefix}${quote}${value
      .split(/\s+/)
      .map((part) => renameIdToken(part))
      .join(" ")}${quote}`;
  });

  next = next.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) => scrubCss(block));

  next = next.replace(/id=(["'])simple-image-slider-js\1/gi, 'id="site-slider-js"');
  next = next.replace(/\/wp-content\/plugins\/simple-image-slider\//gi, "/assets/slider/");

  return next;
}
