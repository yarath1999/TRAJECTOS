"use client";
import React, { useEffect, useState, useRef, useCallback } from 'react';

import { createSupabaseClient } from '@/lib/supabase';

const CATEGORIES = ["Markets","Economy","Geopolitics","Technology","Energy","Crypto","AI","Global"] as const;

type FeedItem = {
  id: string;
  title: string;
  summary: string;
  source?: string;
  published_at?: string;

  importance_score?: string;
  market_impact?: string;
  confidence_signal?: string;

  regime_hint?: string;
  category?: string;

  affected_assets?: string[];

  why_this_matters?: string;

  cluster_id?: string;

  bookmarked?: boolean;

  [key: string]: unknown;
};

type SessionContext = {
  accessToken: string;
};

async function fetchBookmarks(accessToken: string): Promise<string[]> {
  const res = await fetch('/api/intelligence/bookmark', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error('Failed to load bookmarks');
  }

  const body = await res.json();
  return Array.isArray(body.bookmarks) ? body.bookmarks.map((value: unknown) => String(value)) : [];
}

function applyBookmarks(items: FeedItem[], bookmarkedIds: string[]): FeedItem[] {
  const bookmarkedSet = new Set(bookmarkedIds);
  return items.map((item) => ({
    ...item,
    bookmarked: bookmarkedSet.has(item.id),
  }));
}

async function getSessionContext(retries = 40, delayMs = 250): Promise<SessionContext | null> {
  try {
    const supabase = createSupabaseClient();
    if (!supabase) return null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const { data, error } = await supabase.auth.getSession();
      if (!error && data.session?.access_token) {
        return {
          accessToken: data.session.access_token,
        };
      }

      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchPage(offset: number, limit: number, q?: string, category?: string, importance?: string) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (importance) params.set('importance', importance);
  const res = await fetch(`/api/intelligence/feed?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to load feed');
  const body = await res.json();
  return {
    items: body.items as FeedItem[],
    hasMore: Boolean(body.hasMore),
  };
}

function SkeletonCard() {
  const skeletonStyles: React.CSSProperties = { background: 'rgba(200,200,200,0.1)', borderRadius: 8, height: 16, marginBottom: 12 };
  return (
    <div style={{padding:'16px', borderRadius:12, border:'1px solid rgba(200,200,200,0.2)', marginBottom:12}}>
      <div style={{...skeletonStyles, marginBottom: 24}} />
      <div style={{...skeletonStyles, width:'60%', marginBottom: 16}} />
      <div style={{...skeletonStyles, marginBottom: 8}} />
      <div style={{...skeletonStyles, width:'70%'}} />
    </div>
  );
}

export default function FeedClient() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [bookmarkedIds, setBookmarkedIds] = useState<string[]>([]);
  const limit = 12;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [importance, setImportance] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(false);
  const [pullRefresh, setPullRefresh] = useState(false);
  const [bookmarkAnimation, setBookmarkAnimation] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const loaderRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const touchStartY = useRef(0);
  const loadingRef = useRef(false);
  const isBootstrappingRef = useRef(true);

  const colors = {
    light: { bg: '#ffffff', text: '#000', border: '#eee', card: '#f9f9f9', textMuted: '#666' },
    dark: { bg: '#1a1a1a', text: '#eee', border: '#333', card: '#2a2a2a', textMuted: '#aaa' }
  };
  const scheme = darkMode ? colors.dark : colors.light;

  // Check user preference on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const prefDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setDarkMode(prefDark);
    }
  }, []);

const loadMore = useCallback(async () => {
  if (loadingRef.current || !hasMore || isBootstrappingRef.current) return;

  loadingRef.current = true;
  setLoading(true);

  try {
    const page = await fetchPage(
      offset,
      limit,
      query || undefined,
      category || undefined,
      importance || undefined
    );

    setItems((s) => {
  const existing = new Set(s.map((x) => x.id));

  const unique = applyBookmarks(page.items.filter((x) => !existing.has(x.id)), bookmarkedIds);

  return [...s, ...unique];
});
    setOffset((o) => o + page.items.length);
    setHasMore(page.hasMore);
  } finally {
    setLoading(false);
    loadingRef.current = false;
  }
}, [offset, query, category, importance, hasMore, bookmarkedIds]);

  // Reset when filters change
  useEffect(() => {
    let mounted = true;
    (async () => {
      isBootstrappingRef.current = true;
      loadingRef.current = true;
      setLoading(true);
      try {
        const sessionContext = await getSessionContext();
        const [first, bookmarkList] = await Promise.all([
          fetchPage(0, limit, query || undefined, category || undefined, importance || undefined),
          sessionContext ? fetchBookmarks(sessionContext.accessToken) : Promise.resolve([]),
        ]);
        if (!mounted) return;
        setBookmarkedIds(bookmarkList);
        setItems(applyBookmarks(first.items, bookmarkList));
        setOffset(first.items.length);
        setHasMore(first.hasMore);
      } finally {
        if (mounted) {
          setLoading(false);
          loadingRef.current = false;
          isBootstrappingRef.current = false;
        }
      }
    })();
    return () => { mounted = false; };
  }, [query, category, importance]);

  // Rehydrate bookmarks again when Supabase finishes restoring auth state.
  useEffect(() => {
    let mounted = true;
    const supabase = createSupabaseClient();
    if (!supabase) return;

    const syncBookmarks = async (accessToken: string) => {
      try {
        const bookmarkList = await fetchBookmarks(accessToken);
        if (!mounted) return;
        setBookmarkedIds(bookmarkList);
        setItems((current) => applyBookmarks(current, bookmarkList));
      } catch (error) {
        console.error(error);
      }
    };

    void (async () => {
      const sessionContext = await getSessionContext();
      if (mounted && sessionContext) {
        await syncBookmarks(sessionContext.accessToken);
      }
    })();

    const { data: authSubscription } = supabase.auth.onAuthStateChange((_, session) => {
      if (!mounted || !session?.access_token) return;
      void syncBookmarks(session.access_token);
    });

    return () => {
      mounted = false;
      authSubscription.subscription.unsubscribe();
    };
  }, [query, category, importance]);

  // Infinite scroll
  useEffect(() => {
    const el = loaderRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (
        entries[0]?.isIntersecting &&
        !loading &&
        hasMore &&
        !isBootstrappingRef.current &&
        !loadingRef.current
    ) {
        loadMore().catch(console.error);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loading, loadMore, hasMore]);

  // Pull-to-refresh
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0]?.clientY ?? 0;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!containerRef.current) return;
    const dy = (e.touches[0]?.clientY ?? 0) - touchStartY.current;
    if (containerRef.current.scrollTop === 0 && dy > 60) {
      setPullRefresh(true);
    }
  };

  const handleTouchEnd = async () => {
    if (pullRefresh) {
      setPullRefresh(false);
      loadingRef.current = true;
      setLoading(true);
      try {
        const sessionContext = await getSessionContext();
        const [first, bookmarkList] = await Promise.all([
          fetchPage(0, limit, query || undefined, category || undefined, importance || undefined),
          sessionContext ? fetchBookmarks(sessionContext.accessToken) : Promise.resolve([]),
        ]);
        setBookmarkedIds(bookmarkList);
        setItems(applyBookmarks(first.items, bookmarkList));
        setOffset(first.items.length);
        setHasMore(first.hasMore);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    }
  };

  async function toggleBookmark(itemId: string) {
    try {
      setBookmarkError(null);
      const sessionContext = await getSessionContext();
      if (!sessionContext) {
        setBookmarkError('Sign in to save bookmarks.');
        return;
      }

      const res = await fetch('/api/intelligence/bookmark', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionContext.accessToken}` }, body: JSON.stringify({ eventId: itemId, feedItemId: itemId }) });
      if (!res.ok) throw new Error('bookmark failed');

      const json = await res.json();
      setBookmarkAnimation(itemId);
      setTimeout(() => setBookmarkAnimation(null), 600);
      setBookmarkedIds((current) => {
        const next = new Set(current);
        if (json.removed) {
          next.delete(itemId);
        } else {
          next.add(itemId);
        }
        return Array.from(next);
      });
      setItems((s) => s.map((it) => (it.id === itemId ? { ...it, bookmarked: !json.removed } : it)));
    } catch (err) {
      console.error(err);
      setBookmarkError(err instanceof Error ? err.message : 'Failed to update bookmark');
    }
  }

  async function copySummary(itemId: string, summary: string) {
    try {
      await navigator.clipboard.writeText(summary);
      setCopyFeedback(itemId);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error(err);
    }
  }

  async function shareItem(item: FeedItem) {
    if (navigator.share) {
      try {
        await navigator.share({ title: item.title, text: item.summary, url: window.location.href });
      } catch (err) {
        console.error(err);
      }
    } else {
      copySummary(item.id, `${item.title}\n\n${item.summary}`);
    }
  }

  return (
    <div ref={containerRef} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} style={{ background: scheme.bg, color: scheme.text, minHeight: '100vh', transition: 'background 0.2s' }}>
      {/* Pull-to-refresh indicator */}
      {pullRefresh && <div style={{padding:'8px', textAlign:'center', fontSize:12, background:'rgba(100,150,255,0.2)'}}>Release to refresh…</div>}

      {/* Dark mode toggle */}
      <div style={{padding:'12px 16px', display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom:`1px solid ${scheme.border}`}}>
        <h1 style={{margin:0, fontSize:'18px'}}>Intelligence Feed</h1>
        <button onClick={()=>setDarkMode(!darkMode)} style={{background:'transparent', border:'none', cursor:'pointer', fontSize:'18px'}}>{darkMode ? '☀️' : '🌙'}</button>
      </div>

      {bookmarkError ? (
        <div style={{padding:'10px 16px', color:'#b91c1c', background:'rgba(185,28,28,0.08)', borderBottom:`1px solid ${scheme.border}`, fontSize:12}}>
          {bookmarkError}
        </div>
      ) : null}

      {/* Search bar */}
      <div style={{padding:'12px 16px', borderBottom:`1px solid ${scheme.border}`, background: scheme.card}}>
        <input placeholder="Search…" value={query} onChange={(e)=>setQuery(e.target.value)} style={{width:'100%', padding:'10px 12px', borderRadius:8, border:`1px solid ${scheme.border}`, background:scheme.bg, color:scheme.text}} />
      </div>

      {/* Category tabs */}
      <div style={{display:'flex', overflowX:'auto', gap:'8px', padding:'12px 16px', borderBottom:`1px solid ${scheme.border}`, scrollBehavior:'smooth'}}>
        <button onClick={()=>setCategory(null)} style={{padding:'6px 12px', borderRadius:20, background: !category ? 'rgb(100,150,255)' : scheme.card, color: !category ? '#fff' : scheme.text, border:'none', cursor:'pointer', whiteSpace:'nowrap', fontSize:'13px'}} >All</button>
        {CATEGORIES.map((cat) => (
          <button key={cat} onClick={()=>setCategory(cat)} style={{padding:'6px 12px', borderRadius:20, background: category === cat ? 'rgb(100,150,255)' : scheme.card, color: category === cat ? '#fff' : scheme.text, border:'none', cursor:'pointer', whiteSpace:'nowrap', fontSize:'13px'}}>
            {cat}
          </button>
        ))}
      </div>

      {/* Importance filter row */}
      <div style={{padding:'8px 16px', display:'flex', gap:'8px', borderBottom:`1px solid ${scheme.border}`}}>
        {['High', 'Medium', 'Low'].map((imp) => (
          <button key={imp} onClick={()=>setImportance(importance === imp ? null : imp)} style={{padding:'4px 10px', borderRadius:6, background: importance === imp ? 'rgba(255,100,100,0.2)' : scheme.card, color: importance === imp ? 'crimson' : scheme.text, border:`1px solid ${importance === imp ? 'crimson' : scheme.border}`, cursor:'pointer', fontSize:'12px'}}>
            {imp}
          </button>
        ))}
      </div>

      {/* Feed cards */}
      <div style={{padding:'12px 16px'}}>
        {items.map((it) => (
          <FeedCard key={it.id} item={it} scheme={scheme} onBookmark={()=>toggleBookmark(it.id)} onCopy={()=>copySummary(it.id, it.summary)} onShare={()=>shareItem(it)} isAnimating={bookmarkAnimation === it.id} copyFeedback={copyFeedback === it.id} />
        ))}
        {loading && (
          <div>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}
      </div>

      <div ref={loaderRef} style={{height:40, display:'flex', alignItems:'center', justifyContent:'center', color: scheme.textMuted}}>
        {loading ? <small>Loading…</small> : items.length > 0 ? <small>Scroll for more</small> : null}
      </div>
    </div>
  );
}

function FeedCard({
  item,
  scheme,
  onBookmark,
  onCopy,
  onShare,
  isAnimating,
  copyFeedback
}: {
  item: FeedItem;
  scheme: {
    bg: string;
    text: string;
    border: string;
    card: string;
    textMuted: string;
  };
  onBookmark: ()=>void;
  onCopy: ()=>void;
  onShare: ()=>void;
  isAnimating: boolean;
  copyFeedback: boolean | null;
}) {
  const [showRelated, setShowRelated] = useState(false);
 const [relatedData, setRelatedData] = useState<{
  stories?: Array<{
    id: string;
    title: string;
  }>;
  sectors?: string[];
  themes?: string[];
} | null>(null);

  useEffect(() => {
    if (!showRelated) return;
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`/api/intelligence/related-items?feed_item_id=${encodeURIComponent(item.id)}`);
        if (!res.ok) return;
        const j = await res.json();
        if (mounted) setRelatedData(j.related);
      } catch (err) { console.error(err); }
    })();
    return () => { mounted = false; };
  }, [showRelated, item.id]);

  const impactColors = { Critical: '#ff4444', Moderate: '#ff9800', Low: '#888' };
  const signalColors = { 'Strong Signal': '#4caf50', 'Mixed Signal': '#ff9800', 'Weak Signal': '#999' };

  return (
    <div style={{background: scheme.card, borderRadius:12, padding:16, marginBottom:16, border:`1px solid ${scheme.border}`, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', transition: 'transform 0.2s', transform: isAnimating ? 'scale(0.95)' : 'scale(1)'}}>
      {/* Header with importance and market impact */}
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12, gap:8, flexWrap:'wrap'}}>
        <strong style={{fontSize:'16px', lineHeight:'1.3', flex:1, minWidth:'200px'}}>{item.title}</strong>
        <div style={{display:'flex', gap:6, flexWrap:'wrap', justifyContent:'flex-end'}}>
          <span style={{fontSize:'11px', whiteSpace:'nowrap', background: item.importance_score === 'High' ? 'rgba(255,0,0,0.1)' : 'rgba(255,140,0,0.1)', color: item.importance_score === 'High' ? 'crimson' : 'orange', padding:'3px 8px', borderRadius:4}}>{item.importance_score}</span>
          {item.market_impact && <span style={{fontSize:'11px', whiteSpace:'nowrap', background: `rgba(${(impactColors as Record<string,string>)[item.market_impact as string] === '#ff4444' ? '255,68,68' : '255,152,0'},0.1)`, color: (impactColors as Record<string,string>)[item.market_impact as string], padding:'3px 8px', borderRadius:4}}>📊 {item.market_impact}</span>}
        </div>
      </div>

      {/* Metadata and signal badge */}
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, gap:8, flexWrap:'wrap'}}>
        <div style={{fontSize:'12px', color:scheme.textMuted}}>{item.source ?? 'Unknown'} · {new Date(item.published_at ?? "1970-01-01T00:00:00Z").toLocaleDateString()}</div>
        {item.confidence_signal && <span style={{fontSize:'11px', color:(signalColors as Record<string,string>)[item.confidence_signal as string], fontWeight:'bold'}}>{item.confidence_signal}</span>}
      </div>

      {/* Regime hint badge */}
      {item.regime_hint && (
        <div style={{display:'inline-block', background:'rgba(100,200,255,0.1)', color:'rgb(100,200,255)', padding:'4px 10px', borderRadius:20, fontSize:'11px', marginRight:8, marginBottom:8}}>
          🔮 Regime: {String(item.regime_hint).slice(0, 30)}
        </div>
      )}

      {/* Category badge */}
      <div style={{display:'inline-block', background:'rgba(100,150,255,0.2)', color:'rgb(100,150,255)', padding:'4px 10px', borderRadius:20, fontSize:'12px', marginBottom:12}}>
        {item.category}
      </div>

      {/* Affected assets tags */}
      {item.affected_assets && item.affected_assets.length > 0 && (
        <div style={{marginBottom:12}}>
          <div style={{fontSize:'11px', color:scheme.textMuted, marginBottom:6}}>Affected Assets:</div>
          <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
            {item.affected_assets.slice(0, 8).map((asset: string) => (
              <span key={asset} style={{background:'rgba(200,200,200,0.2)', color:scheme.text, padding:'2px 8px', borderRadius:12, fontSize:'11px'}}>
                💰 {asset}
              </span>
            ))}
            {item.affected_assets.length > 8 && <span style={{color:scheme.textMuted, fontSize:'11px', alignSelf:'center'}}>+{item.affected_assets.length - 8}</span>}
          </div>
        </div>
      )}

      {/* Summary */}
      <p style={{fontSize:'14px', lineHeight:'1.5', marginBottom:12, color:scheme.text}}>{item.summary}</p>

      {/* Why this matters */}
      {item.why_this_matters && (
        <p style={{fontSize:'13px', fontStyle:'italic', color:scheme.textMuted, background:'rgba(100,150,255,0.05)', padding:8, borderRadius:6, marginBottom:12}}>
          💡 {item.why_this_matters}
        </p>
      )}

      {/* Related allocation */}
      {item.cluster_id && (
        <div style={{marginBottom:12}}>
          <button onClick={()=>setShowRelated(!showRelated)} style={{background:'transparent', border:'none', cursor:'pointer', color:'rgb(100,150,255)', fontSize:'13px', padding:0}}>
            {showRelated ? '−' : '+'} Related Allocation Insight
          </button>
          {showRelated && <RelatedAllocation clusterId={item.cluster_id} scheme={scheme} />}
        </div>
      )}

      {/* Cross-linking section */}
      {showRelated && relatedData && (
        <div style={{background:'rgba(100,150,255,0.05)', padding:12, borderRadius:6, marginBottom:12, fontSize:'12px'}}>
          <strong style={{display:'block', marginBottom:8}}>Related Intelligence</strong>
          {relatedData.stories && relatedData.stories.length > 0 && (
            <div style={{marginBottom:8}}>
              <div style={{color:scheme.textMuted, fontSize:'11px'}}>Related Stories:</div>
              {relatedData.stories.map((s) => (
                <div key={s.id} style={{fontSize:'12px', marginTop:4}}>• {s.title.slice(0, 60)}...</div>
              ))}
            </div>
          )}
          {relatedData.sectors && relatedData.sectors.length > 0 && (
            <div style={{marginBottom:8}}>
              <div style={{color:scheme.textMuted, fontSize:'11px'}}>Related Sectors:</div>
              <div style={{display:'flex', gap:6, flexWrap:'wrap', marginTop:4}}>
                {relatedData.sectors.map((s: string) => (
                  <span key={s} style={{background:'rgba(200,200,200,0.2)', padding:'2px 6px', borderRadius:8, fontSize:'10px'}}>{s}</span>
                ))}
              </div>
            </div>
          )}
          {relatedData.themes && relatedData.themes.length > 0 && (
            <div>
              <div style={{color:scheme.textMuted, fontSize:'11px'}}>Related Themes:</div>
              <div style={{display:'flex', gap:6, flexWrap:'wrap', marginTop:4}}>
                {relatedData.themes.map((t: string) => (
                  <span key={t} style={{background:'rgba(100,200,255,0.1)', color:'rgb(100,200,255)', padding:'2px 6px', borderRadius:8, fontSize:'10px'}}>{t}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div style={{display:'flex', gap:8, marginTop:12, flexWrap:'wrap'}}>
        <button onClick={onCopy} style={{flex:1, padding:'8px 12px', borderRadius:6, background:copyFeedback ? 'rgba(100,200,100,0.2)' : scheme.bg, border:`1px solid ${scheme.border}`, color:copyFeedback ? 'green' : scheme.text, cursor:'pointer', fontSize:'12px', transition:'all 0.2s', minWidth:'60px'}}>
          {copyFeedback ? '✓ Copied' : '📋 Copy'}
        </button>
        <button onClick={onShare} style={{flex:1, padding:'8px 12px', borderRadius:6, background:scheme.bg, border:`1px solid ${scheme.border}`, color:scheme.text, cursor:'pointer', fontSize:'12px', minWidth:'60px'}}>
          🔗 Share
        </button>
        <button onClick={onBookmark} style={{flex:1, padding:'8px 12px', borderRadius:6, background:isAnimating ? 'rgba(255,200,0,0.2)' : scheme.bg, border:`1px solid ${isAnimating ? 'orange' : scheme.border}`, color:isAnimating ? 'orange' : scheme.text, cursor:'pointer', fontSize:'12px', transition:'all 0.2s', minWidth:'60px'}}>
          {isAnimating ? '✨ Saved' : '🔖 Save'}
        </button>
      </div>
    </div>
  );
}

function RelatedAllocation({
  clusterId,
  scheme
}: {
  clusterId: string;
  scheme: {
    bg: string;
    text: string;
    border: string;
    card: string;
    textMuted: string;
  };
}) {
  const [data, setData] = useState<{
  cluster?: {
    title?: string;
    summary?: string;
  };
} | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(()=>{
    let mounted = true;
    (async ()=>{
      try {
        const res = await fetch(`/api/intelligence/related?cluster_id=${encodeURIComponent(clusterId)}`);
        if (!res.ok) return;
        const j = await res.json();
        if (mounted) setData(j);
      } catch (err) { console.error(err); }
      finally { if (mounted) setLoading(false); }
    })();
    return ()=>{ mounted=false };
  }, [clusterId]);

  if (loading) return <div style={{fontSize:'13px', color:scheme.textMuted, marginTop:8}}>Loading…</div>;
  if (!data || !data.cluster) return null;
  const c = data.cluster;
  return (
    <div style={{background:'rgba(100,150,255,0.05)', padding:10, borderRadius:6, marginTop:8, borderLeft:`3px solid rgb(100,150,255)`, fontSize:'12px', color:scheme.text}}>
      <strong>Cluster Context:</strong> {c.title ?? c.summary ?? '—'}
      <div style={{fontSize:'11px', color:scheme.textMuted, marginTop:4}}>Read-only informational</div>
    </div>
  );
}
