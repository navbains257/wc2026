// ESM resolve hook: lets Node import db.js unchanged.
// db.js loads Supabase from a browser-native URL ('https://esm.sh/@supabase/supabase-js@2')
// so GitHub Pages can serve it with no build step. Node can't resolve that URL, so under test
// we transparently redirect it to the @supabase/supabase-js package installed in node_modules.
// This changes nothing about db.js or the scoring — it only affects how the dependency resolves.
export async function resolve(specifier, context, next) {
  if (/^https:\/\/esm\.sh\/@supabase\/supabase-js/.test(specifier)) {
    return next('@supabase/supabase-js', context);
  }
  return next(specifier, context);
}
