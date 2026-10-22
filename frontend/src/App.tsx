import React, { useState, useEffect } from 'react';
import { 
  Sun, Moon, Trash2, Copy, Check, Plus, 
  RefreshCw, AlertCircle, Link, Rss, Youtube, 
  MessageSquare, Globe, X, ExternalLink, Settings,
  Inbox, MailOpen, CheckCheck, ChevronDown, ChevronUp,
  Activity, Clock, AlertTriangle
} from 'lucide-react';
import { Feed, FeedItem, FeedType, ScrapedFeedItem, RefreshRun, RefreshRunsResponse } from './types.js';
import RefreshChart from './components/RefreshChart.js';

export default function App() {
  // Theme state
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  // Feeds state
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Modal & Form state
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [ttl, setTtl] = useState<number>(15);
  
  interface FormSource {
    id?: string;
    url: string;
    type: FeedType;
    config: any;
    lastFetched?: string | null;
    nextRefreshAt?: string | null;
    lastAttemptAt?: string | null;
    consecutiveFailures?: number;
    lastError?: string | null;
    testResult?: { count: number; items: ScrapedFeedItem[] } | null;
    testError?: string | null;
    testing?: boolean;
  }

  const [formSources, setFormSources] = useState<FormSource[]>([
    { url: '', type: 'rss', config: {} }
  ]);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);

  const getInitialConfigForType = (type: FeedType) => {
    switch (type) {
      case 'youtube':
        return { includeShorts: true };
      case 'fourchan':
        return { board: 'g', query: '', topN: 10 };
      case 'html':
        return { itemSelector: '', titleSelector: '', linkSelector: '', descriptionSelector: '', pubDateSelector: '' };
      default:
        return {};
    }
  };

  const [copiedFeedId, setCopiedFeedId] = useState<string | null>(null);
  const [refreshingFeedId, setRefreshingFeedId] = useState<string | null>(null);
  const [refreshingSourceId, setRefreshingSourceId] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  // Refresh activity panel
  const [activityOpen, setActivityOpen] = useState<boolean>(false);
  const [runs, setRuns] = useState<RefreshRun[]>([]);
  const [runsMeta, setRunsMeta] = useState<RefreshRunsResponse | null>(null);
  const [runsLoading, setRunsLoading] = useState<boolean>(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsRange, setRunsRange] = useState<number>(24);

  // Items reader state
  const [itemsModalOpen, setItemsModalOpen] = useState<boolean>(false);
  const [itemsFeedId, setItemsFeedId] = useState<string | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState<number>(0);
  const [itemsUnreadTotal, setItemsUnreadTotal] = useState<number>(0);
  const [itemsLoading, setItemsLoading] = useState<boolean>(false);
  const [itemsOffset, setItemsOffset] = useState<number>(0);
  const [itemsUnreadOnly, setItemsUnreadOnly] = useState<boolean>(false);
  const ITEMS_PAGE_SIZE = 50;

  // Apply dark mode theme
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  // Listen to system dark/light theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      const saved = localStorage.getItem('theme');
      if (!saved) {
        setDarkMode(e.matches);
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const handleToggleTheme = () => {
    const nextMode = !darkMode;
    setDarkMode(nextMode);
    localStorage.setItem('theme', nextMode ? 'dark' : 'light');
  };

  // Fetch registered feeds
  const fetchFeeds = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/feeds');
      if (!res.ok) throw new Error('Failed to load feeds from server');
      const data = await res.json();
      setFeeds(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeeds();
  }, []);

  // --- Items reader ---
  const loadItems = async (feedId: string | null, unreadOnly: boolean, offset: number, append: boolean) => {
    setItemsLoading(true);
    try {
      const params = new URLSearchParams();
      if (feedId) params.set('feedId', feedId);
      if (unreadOnly) params.set('unreadOnly', 'true');
      params.set('limit', String(ITEMS_PAGE_SIZE));
      params.set('offset', String(offset));
      const res = await fetch(`/api/items?${params}`);
      if (!res.ok) throw new Error('Failed to load items');
      const data = await res.json();
      setItems((prev) => (append ? [...prev, ...data.items] : data.items));
      setItemsTotal(data.total);
      setItemsUnreadTotal(data.unreadTotal);
      setItemsOffset(offset + data.items.length);
    } catch (err: any) {
      alert(`Error loading items: ${err.message}`);
    } finally {
      setItemsLoading(false);
    }
  };

  const openItems = async (feedId: string | null) => {
    setItemsFeedId(feedId);
    setItems([]);
    setItemsOffset(0);
    setItemsModalOpen(true);
    await loadItems(feedId, itemsUnreadOnly, 0, false);
  };

  const refreshItems = (unreadOnly: boolean) => {
    loadItems(itemsFeedId, unreadOnly, 0, false);
  };

  const toggleUnreadFilter = () => {
    const next = !itemsUnreadOnly;
    setItemsUnreadOnly(next);
    refreshItems(next);
  };

  const markItemRead = async (item: FeedItem) => {
    if (item.read) return;
    const res = await fetch(`/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: true }),
    });
    if (!res.ok) return;
    if (itemsUnreadOnly) {
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setItemsTotal((t) => Math.max(0, t - 1));
    } else {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
    }
    setItemsUnreadTotal((u) => Math.max(0, u - 1));
    fetchFeeds(); // refresh unread badges
  };

  const markAllRead = async () => {
    const res = await fetch('/api/items/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(itemsFeedId ? { feedId: itemsFeedId } : {}),
    });
    if (!res.ok) return;
    setItems((prev) => prev.map((i) => ({ ...i, read: true })));
    setItemsUnreadTotal(0);
    fetchFeeds();
  };

  const handleOpenItem = (item: FeedItem) => {
    window.open(item.link, '_blank', 'noopener');
    markItemRead(item);
  };

  // Delete feed
  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this feed? All cached items will be permanently removed.')) {
      return;
    }
    try {
      const res = await fetch(`/api/feeds/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete feed');
      setFeeds(feeds.filter(feed => feed.id !== id));
    } catch (err: any) {
      alert(`Error deleting feed: ${err.message}`);
    }
  };

  // Force Refresh Cache manually
  const handleRefreshFeed = async (id: string) => {
    setRefreshingFeedId(id);
    try {
      const res = await fetch(`/api/feeds/${id}/refresh?force=1`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to refresh feed cache');
      await fetchFeeds();
    } catch (err: any) {
      alert(`Error refreshing feed cache: ${err.message}`);
    } finally {
      setRefreshingFeedId(null);
    }
  };

  // Load recent refresh ticks for the activity graph
  const loadRuns = async () => {
    setRunsLoading(true);
    try {
      const res = await fetch('/api/refresh/runs?hours=168');
      if (!res.ok) throw new Error('Failed to load refresh activity');
      const data: RefreshRunsResponse = await res.json();
      setRuns(data.runs);
      setRunsMeta(data);
      setRunsError(null);
    } catch (err: any) {
      setRunsError(err.message || 'Failed to load refresh activity');
    } finally {
      setRunsLoading(false);
    }
  };

  const toggleActivity = () => {
    const next = !activityOpen;
    setActivityOpen(next);
    if (next && runs.length === 0 && !runsLoading) {
      loadRuns();
    }
  };

  // Force-refresh one source, then re-anchor its schedule in the editor
  const handleRefreshSource = async (sourceId: string) => {
    setRefreshingSourceId(sourceId);
    try {
      const res = await fetch(`/api/sources/${sourceId}/refresh`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to refresh source');
      if (data.failed) throw new Error(data.error || 'Source refresh failed');

      const updated = data.source;
      setFormSources((prev) =>
        prev.map((source) =>
          source.id === sourceId
            ? {
                ...source,
                lastFetched: updated.lastFetched,
                nextRefreshAt: updated.nextRefreshAt,
                lastAttemptAt: updated.lastAttemptAt,
                consecutiveFailures: updated.consecutiveFailures,
                lastError: updated.lastError,
              }
            : source
        )
      );
      fetchFeeds();
    } catch (err: any) {
      await fetchFeeds();
      alert(`Error refreshing source: ${err.message}`);
    } finally {
      setRefreshingSourceId(null);
    }
  };


  // Run Real-time Selector Test for a specific source row
  const handleTestSource = async (index: number) => {
    const source = formSources[index];
    if (!source.url && source.type !== 'fourchan') {
      alert('Please enter a URL to test');
      return;
    }

    const updated = [...formSources];
    updated[index] = { ...source, testing: true, testResult: null, testError: null };
    setFormSources(updated);

    let testUrl = source.url;
    let configPayload = source.config;

    if (source.type === 'fourchan') {
      testUrl = `https://boards.4channel.org/${source.config.board}/`;
    }

    try {
      const res = await fetch('/api/feeds/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: source.type,
          url: testUrl,
          config: configPayload,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server testing failed');
      
      const latest = [...formSources];
      latest[index] = { ...source, testing: false, testResult: data, testError: null };
      setFormSources(latest);
    } catch (err: any) {
      const latest = [...formSources];
      latest[index] = { ...source, testing: false, testResult: null, testError: err.message || 'Scraper test failed' };
      setFormSources(latest);
    }
  };

  // Register feed to database or update existing one
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || formSources.some(s => !s.url && s.type !== 'fourchan')) {
      alert('Please fill out all required fields');
      return;
    }

    const payload = {
      name,
      ttl: ttl,
      sources: formSources.map((s) => ({
        id: s.id,
        url: s.type === 'fourchan' ? `https://boards.4channel.org/${s.config.board}/` : s.url,
        type: s.type,
        config: s.config,
      })),
    };

    setSaving(true);
    try {
      const url = editingFeed ? `/api/feeds/${editingFeed.id}` : '/api/feeds';
      const method = editingFeed ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save feed');
      }

      setIsModalOpen(false);
      resetForm();
      fetchFeeds();
    } catch (err: any) {
      alert(`Error saving feed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    setName('');
    setTtl(15);
    setFormSources([{ url: '', type: 'rss', config: {} }]);
    setEditingFeed(null);
  };

  const handleEditClick = (feed: Feed) => {
    setEditingFeed(feed);
    setName(feed.name);
    setTtl(feed.ttl);
    const mappedSources = feed.sources.map((source) => ({
      id: source.id,
      url: source.url,
      type: source.type,
      config: source.config ? JSON.parse(source.config) : getInitialConfigForType(source.type),
      lastFetched: source.lastFetched,
      nextRefreshAt: source.nextRefreshAt,
      lastAttemptAt: source.lastAttemptAt,
      consecutiveFailures: source.consecutiveFailures,
      lastError: source.lastError,
    }));
    setFormSources(mappedSources);
    setIsModalOpen(true);
  };

  // Copy helper with temporary check feedback
  const copyText = (text: string, onCopied: () => void) => {
    navigator.clipboard.writeText(text);
    onCopied();
    setTimeout(onCopied, 2000);
  };

  // Copy feed link helper
  const handleCopyLink = (feedId: string) => {
    copyText(`${window.location.origin}/feeds/${feedId}`, () => setCopiedFeedId(feedId));
  };

  // Format date helper
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Soonest scheduled source check in a feed (for the table tooltip)
  const nextSourceCheck = (feed: Feed): string | null => {
    const times = feed.sources
      .map((source) => source.nextRefreshAt)
      .filter((value): value is string => Boolean(value));
    if (times.length === 0) return null;
    return times.reduce((earliest, current) =>
      new Date(current).getTime() < new Date(earliest).getTime() ? current : earliest
    );
  };

  // Last tick summary shown in the collapsed activity strip
  const activityLastRun = runsMeta?.lastRun ?? runs[runs.length - 1] ?? null;
  const activityBudget = runsMeta?.currentBudget ?? activityLastRun?.budget ?? 4;
  const nextTickLabel = (() => {
    if (!activityLastRun?.finishedAt) return null;
    const dueAt =
      new Date(activityLastRun.finishedAt).getTime() +
      (runsMeta?.tickIntervalMinutes ?? 5) * 60 * 1000;
    const minutes = Math.round((dueAt - Date.now()) / 60000);
    return minutes > 0 ? `in ~${minutes}m` : 'due now';
  })();

  // Sources whose last attempt failed, worst first
  const failedSources = feeds
    .flatMap((feed) =>
      feed.sources
        .filter((source) => (source.consecutiveFailures ?? 0) > 0)
        .map((source) => ({ feed, source }))
    )
    .sort(
      (a, b) =>
        (b.source.consecutiveFailures ?? 0) - (a.source.consecutiveFailures ?? 0) ||
        a.feed.name.localeCompare(b.feed.name) ||
        (a.source.url || '').localeCompare(b.source.url || '')
    );

  // Strip HTML tags for the item snippet
  const stripHtml = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  // Badge mapping
  const getBadgeClass = (type: FeedType) => {
    switch (type) {
      case 'rss': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'youtube': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      case 'reddit': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
      case 'fourchan': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'html': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
    }
  };

  const getPlatformIcon = (type: FeedType) => {
    switch (type) {
      case 'rss': return <Rss className="w-4 h-4 mr-1" />;
      case 'youtube': return <Youtube className="w-4 h-4 mr-1" />;
      case 'reddit': return <Globe className="w-4 h-4 mr-1" />;
      case 'fourchan': return <MessageSquare className="w-4 h-4 mr-1" />;
      case 'html': return <Globe className="w-4 h-4 mr-1" />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100 transition-colors duration-200">
      
      {/* HEADER */}
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="bg-indigo-600 text-white p-2 rounded-lg">
              <Rss className="w-6 h-6" />
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight">RSS Aggregator</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">Custom Feed Configurator</p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <button 
              onClick={handleToggleTheme}
              className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 border border-gray-200 dark:border-gray-800 transition"
              title="Toggle Theme"
            >
              {darkMode ? <Sun className="w-5 h-5 text-amber-500" /> : <Moon className="w-5 h-5 text-indigo-500" />}
            </button>
            <button 
              onClick={() => { resetForm(); setIsModalOpen(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-4 py-2 rounded-lg shadow-sm flex items-center space-x-1 transition"
            >
              <Plus className="w-5 h-5" />
              <span>Add Feed</span>
            </button>
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        
        {error && (
          <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4 rounded dark:bg-red-950/20 dark:border-red-900 flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-red-500 mt-0.5" />
            <div>
              <h3 className="font-semibold text-red-800 dark:text-red-400">Connection Error</h3>
              <p className="text-sm text-red-700 dark:text-red-500">{error}</p>
            </div>
          </div>
        )}

        {/* REFRESH ACTIVITY PANEL */}
        <div className="mb-6 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-sm overflow-hidden">
          <div
            role="button"
            tabIndex={0}
            onClick={toggleActivity}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleActivity();
              }
            }}
            className="w-full px-6 py-3 flex items-center justify-between gap-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40 transition"
          >
            <span className="flex items-center gap-2 font-semibold text-sm shrink-0">
              <Activity className="w-4 h-4 text-indigo-500" />
              <span>Refresh activity</span>
            </span>
            <span className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400 text-right">
              {runsLoading && runs.length === 0 ? (
                <span>Loading ticks…</span>
              ) : activityLastRun ? (
                <>
                  {nextTickLabel && <span>next tick {nextTickLabel}</span>}
                  <span aria-hidden="true">·</span>
                  <span>budget {activityBudget}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    last tick {activityLastRun.attempted} of {activityLastRun.budget}
                  </span>
                  {activityLastRun.due > activityLastRun.budget && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-amber-600 dark:text-amber-400 font-semibold">
                        due {activityLastRun.due}
                      </span>
                    </>
                  )}
                </>
              ) : (
                <span>No ticks recorded yet</span>
              )}
              {activityOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </span>
          </div>

          {activityOpen && (
            <div className="px-6 pb-5 border-t border-gray-200 dark:border-gray-800">
              <div className="flex items-center justify-between py-3">
                <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
                  {([
                    [6, '6h'],
                    [24, '24h'],
                    [168, '7d'],
                  ] as const).map(([hours, label]) => (
                    <button
                      key={hours}
                      onClick={() => setRunsRange(hours)}
                      className={`px-3 py-1.5 font-semibold transition ${
                        runsRange === hours
                          ? 'bg-indigo-600 text-white'
                          : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={loadRuns}
                  disabled={runsLoading}
                  className="p-1.5 text-gray-500 hover:text-indigo-600 dark:text-gray-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition disabled:opacity-50"
                  title="Reload tick history"
                >
                  <RefreshCw className={`w-4 h-4 ${runsLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {runsError && (
                <div className="mb-3 text-xs text-red-600 dark:text-red-400">{runsError}</div>
              )}

              <RefreshChart
                runs={runs}
                rangeHours={runsRange}
                currentBudget={runsMeta?.currentBudget}
                dueNow={runsMeta?.dueNow}
                tickIntervalMinutes={runsMeta?.tickIntervalMinutes}
              />
            </div>
          )}
        </div>

        {/* FAILING SOURCES */}
        {failedSources.length > 0 && (
          <div className="mb-6 bg-white dark:bg-gray-900 border border-red-200 dark:border-red-900/60 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-3 flex items-center justify-between gap-4 border-b border-red-100 dark:border-red-900/40 bg-red-50/60 dark:bg-red-950/20">
              <span className="flex items-center gap-2 font-semibold text-sm text-red-800 dark:text-red-300">
                <AlertTriangle className="w-4 h-4" />
                <span>Failing sources</span>
                <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-600 text-white text-[10px] font-bold">
                  {failedSources.length}
                </span>
              </span>
              <button
                onClick={fetchFeeds}
                disabled={loading}
                className="p-1.5 text-red-500 hover:text-red-700 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition disabled:opacity-50"
                title="Reload failure status"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <ul className="divide-y divide-gray-200 dark:divide-gray-800 max-h-96 overflow-y-auto">
              {failedSources.map(({ feed, source }) => {
                const failures = source.consecutiveFailures ?? 0;
                const retrying = refreshingSourceId === source.id;
                return (
                  <li key={source.id ?? `${feed.id}:${source.url}`} className="px-6 py-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm">{feed.name}</span>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-none ${getBadgeClass(source.type)}`}>
                            {getPlatformIcon(source.type)}
                            <span className="capitalize">
                              {source.type === 'fourchan' ? '4chan' : source.type === 'html' ? 'Custom HTML' : source.type}
                            </span>
                          </span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">
                            {failures} failure{failures === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 truncate" title={source.url}>
                          {source.resolvedUrl || source.url || 'No URL'}
                        </div>
                        {source.lastError && (
                          <div
                            className="mt-1 text-xs text-red-600 dark:text-red-400 line-clamp-2"
                            title={source.lastError}
                          >
                            {source.lastError}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400 sm:text-right">
                        <div>last attempt {formatDate(source.lastAttemptAt ?? null)}</div>
                        <div>next retry {formatDate(source.nextRefreshAt ?? null)}</div>
                        {source.id && (
                          <button
                            type="button"
                            onClick={() => handleRefreshSource(source.id!)}
                            disabled={retrying}
                            className="mt-1 inline-flex items-center gap-1 font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 disabled:opacity-50"
                            title="Retry this source now"
                          >
                            <RefreshCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
                            Retry now
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* FEED TABLE LIST */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden shadow-sm">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
            <h2 className="font-semibold text-lg">Active Feeds</h2>
            <div className="flex items-center space-x-2">
              <button 
                onClick={() => openItems(null)}
                className="inline-flex items-center space-x-1.5 text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 text-xs font-semibold px-3 py-2 rounded-lg border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/30 dark:hover:bg-indigo-950/50 transition"
                title="Browse every aggregated item"
              >
                <Inbox className="w-4 h-4" />
                <span>All items</span>
              </button>
              <button 
                onClick={fetchFeeds}
                className="p-2 text-gray-500 hover:text-indigo-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                title="Refresh Feeds"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {loading && feeds.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-3 text-indigo-600" />
              <p>Loading your registered feeds...</p>
            </div>
          ) : feeds.length === 0 ? (
            <div className="p-12 text-center max-w-md mx-auto">
              <Rss className="w-12 h-12 text-gray-300 dark:text-gray-700 mx-auto mb-4" />
              <h3 className="font-semibold text-lg mb-1">No feeds registered</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                Connect standard RSS URLs, subreddits, YouTube channels, or parse custom HTML using selectors.
              </p>
              <button 
                onClick={() => { resetForm(); setIsModalOpen(true); }}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-4 py-2 rounded-lg transition"
              >
                Create your first feed
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900/50 text-xs font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800 align-middle">
                    <th className="px-6 py-3 align-middle text-left">Feed Name / Platforms</th>
                    <th className="px-6 py-3 align-middle text-center">Unread</th>
                    <th className="px-6 py-3 align-middle text-center">Updates</th>
                    <th className="px-6 py-3 align-middle text-center">Copy link</th>
                    <th className="px-6 py-3 align-middle text-center">Last Checked</th>
                    <th className="px-6 py-3 text-right align-middle">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800 text-sm">
                  {feeds.map((feed) => (
                    <tr key={feed.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-900/30 align-middle">
                      <td className="px-6 py-4 font-normal align-middle text-left">
                        <div className="font-semibold text-gray-900 dark:text-white">{feed.name}</div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {Array.from(new Set(feed.sources.map(s => s.type))).map((type) => (
                            <span key={type} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-none ${getBadgeClass(type)}`}>
                              {getPlatformIcon(type)}
                              <span className="capitalize">{type === 'fourchan' ? '4chan' : type === 'html' ? 'Custom HTML' : type}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-6 py-4 align-middle text-center">
                        {feed.unreadCount ? (
                          <button
                            onClick={() => openItems(feed.id)}
                            className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold leading-none bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-900/50 transition"
                            title={`${feed.unreadCount} unread — view items`}
                          >
                            <MailOpen className="w-3 h-3 mr-1" />
                            {feed.unreadCount}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-300 dark:text-gray-600">—</span>
                        )}
                      </td>
                      <td
                        className="px-6 py-4 align-middle text-center font-medium"
                        title={
                          nextSourceCheck(feed)
                            ? `Next source check: ${formatDate(nextSourceCheck(feed))}`
                            : undefined
                        }
                      >
                        {feed.ttl === 0 ? (
                          <span 
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-none bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
                            title="Auto-refresh is off — the feed is only fetched on demand."
                          >
                            On-demand
                          </span>
                        ) : feed.ttl < 60 ? (
                          <span className="text-gray-650 dark:text-gray-350">{feed.ttl} mins</span>
                        ) : (
                          <span className="text-gray-650 dark:text-gray-350">{feed.ttl / 60} hour{feed.ttl / 60 > 1 ? 's' : ''}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 align-middle text-center">
                        <div className="flex items-center space-x-1 bg-gray-50 dark:bg-gray-950 p-1.5 rounded-lg border border-gray-200 dark:border-gray-800 w-fit mx-auto">
                            <button 
                              onClick={() => handleCopyLink(feed.id)}
                              className="p-1 rounded bg-white hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-indigo-600 transition"
                              title="Copy feed link"
                            >
                              {copiedFeedId === feed.id ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                      </td>
                      <td className="px-6 py-4 align-middle text-center text-xs text-gray-500 dark:text-gray-400">
                        {formatDate(feed.lastFetched)}
                      </td>
                      <td className="px-6 py-4 text-right space-x-1 whitespace-nowrap align-middle">
                        <button 
                          onClick={() => openItems(feed.id)}
                          className="p-2 text-gray-405 hover:text-indigo-650 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 rounded-lg transition"
                          title="View items"
                        >
                          <Inbox className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleRefreshFeed(feed.id)}
                          disabled={refreshingFeedId === feed.id}
                          className="p-2 text-gray-405 hover:text-indigo-650 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 rounded-lg transition disabled:opacity-50"
                          title="Force Refresh Cache"
                        >
                          <RefreshCw className={`w-4 h-4 ${refreshingFeedId === feed.id ? 'animate-spin' : ''}`} />
                        </button>
                        <button 
                          onClick={() => handleEditClick(feed)}
                          className="p-2 text-gray-404 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 rounded-lg transition"
                          title="Manage Feed & Sources"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleDelete(feed.id)}
                          className="p-2 text-gray-404 hover:text-red-650 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition"
                          title="Delete Feed"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* ITEMS READER MODAL */}
      {itemsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 w-full max-w-3xl rounded-2xl shadow-xl overflow-hidden my-8 flex flex-col max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-900/50">
              <div className="flex items-center space-x-3">
                <div className="bg-indigo-600 text-white p-2 rounded-lg">
                  <Inbox className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-lg">
                    {itemsFeedId ? (feeds.find((f) => f.id === itemsFeedId)?.name ?? 'Items') : 'All Items'}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {itemsTotal} item{itemsTotal === 1 ? '' : 's'} · {itemsUnreadTotal} unread
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={toggleUnreadFilter}
                  className={`inline-flex items-center space-x-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition ${itemsUnreadOnly
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                  title="Show only unread items"
                >
                  <MailOpen className="w-3.5 h-3.5" />
                  <span>Unread</span>
                </button>
                <button
                  onClick={markAllRead}
                  disabled={itemsUnreadTotal === 0}
                  className="inline-flex items-center space-x-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/30 transition disabled:opacity-40 disabled:pointer-events-none"
                  title="Mark all read"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  <span>Mark all read</span>
                </button>
                <button
                  onClick={() => setItemsModalOpen(false)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-800 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Items List */}
            <div className="overflow-y-auto flex-1 divide-y divide-gray-100 dark:divide-gray-800">
              {itemsLoading && items.length === 0 ? (
                <div className="p-12 text-center text-gray-500">
                  <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-3 text-indigo-600" />
                  <p>Loading items...</p>
                </div>
              ) : items.length === 0 ? (
                <div className="p-12 text-center text-gray-500">
                  <MailOpen className="w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-700" />
                  <p>No items{itemsUnreadOnly ? ' unread' : ''}.</p>
                </div>
              ) : (
                items.map((item) => (
                  <div
                    key={item.id}
                    className={`px-6 py-3.5 flex items-start space-x-3 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition ${item.read ? 'opacity-55' : ''}`}
                  >
                    <span
                      className={`mt-2 w-2 h-2 rounded-full shrink-0 ${item.read ? 'bg-gray-300 dark:bg-gray-700' : 'bg-indigo-500'}`}
                      title={item.read ? 'Read' : 'Unread'}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <button
                          onClick={() => handleOpenItem(item)}
                          className={`text-left truncate hover:underline ${item.read
                            ? 'text-gray-600 dark:text-gray-400 font-normal'
                            : 'text-gray-900 dark:text-white font-semibold'}`}
                        >
                          {item.title || 'Untitled'}
                        </button>
                        <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                          {formatDate(item.pubDate ?? item.createdAt)}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 flex items-center space-x-2">
                        {!itemsFeedId && item.feed && (
                          <span className="font-medium text-indigo-600 dark:text-indigo-400 shrink-0">{item.feed.name}</span>
                        )}
                        {item.description && <span className="truncate flex-1">{stripHtml(item.description)}</span>}
                      </div>
                    </div>
                    <div className="flex items-center space-x-1 shrink-0">
                      {!item.read && (
                        <button
                          onClick={() => markItemRead(item)}
                          className="p-1.5 rounded text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition"
                          title="Mark read"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      )}
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => markItemRead(item)}
                        className="p-1.5 rounded text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition"
                        title="Open link"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Load more */}
            {items.length > 0 && items.length < itemsTotal && (
              <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-800 text-center">
                <button
                  onClick={() => loadItems(itemsFeedId, itemsUnreadOnly, itemsOffset, true)}
                  disabled={itemsLoading}
                  className="text-sm font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 disabled:opacity-50 transition"
                >
                  {itemsLoading ? 'Loading…' : `Load more (${items.length} of ${itemsTotal})`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* REGISTER/EDIT FORM MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 w-full max-w-2xl rounded-2xl shadow-xl overflow-hidden my-8 flex flex-col max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-900/50">
              <div className="flex items-center space-x-2">
                <Plus className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-lg">{editingFeed ? 'Manage Feed & Sources' : 'Register New Feed'}</h3>
              </div>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-800 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto flex-1 space-y-5 text-left">
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Feed Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. My Developer Feed"
                    className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">How often to check for updates</label>
                  <select
                    value={ttl}
                    onChange={(e) => setTtl(parseInt(e.target.value))}
                    className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value="0">Off — only refresh on demand</option>
                    <option value="5">5 minutes</option>
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="720">12 hours</option>
                  </select>
                </div>
              </div>

              {/* Dynamic Sources Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-gray-150 dark:border-gray-850 pb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-500">Aggregate Sources</span>
                  <button
                    type="button"
                    onClick={() => {
                      const lastSource = formSources[0]; // first item (top of list)
                      const lastType = lastSource?.type || 'rss';
                      const lastConfig = lastSource?.config ? { ...lastSource.config } : getInitialConfigForType(lastType);
                      // Clear board details but keep general preferences
                      const newConfig = { ...lastConfig };
                      if (lastType === 'fourchan') {
                        newConfig.query = '';
                      }
                      setFormSources([
                        { url: '', type: lastType, config: newConfig },
                        ...formSources
                      ]);
                    }}
                    className="bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/30 dark:text-indigo-400 border border-indigo-200/50 dark:border-indigo-900/50 text-xs font-semibold px-2.5 py-1 rounded-lg flex items-center space-x-1 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Source</span>
                  </button>
                </div>

                <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                  {formSources.map((source, index) => (
                    <div key={index} className="p-3 bg-gray-50 dark:bg-gray-900/40 rounded-xl border border-gray-200 dark:border-gray-800 relative">
                      {formSources.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setFormSources(formSources.filter((_, i) => i !== index))}
                          className="absolute top-2 right-2 text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-800"
                          title="Remove Source"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Main row layout based on Type */}
                      {source.type !== 'fourchan' ? (
                        <div className="grid grid-cols-12 gap-3 pr-6 items-end">
                          <div className="col-span-3">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Source Type</label>
                            <select
                              value={source.type}
                              onChange={(e) => {
                                const newType = e.target.value as FeedType;
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  type: newType,
                                  config: getInitialConfigForType(newType),
                                  url: '',
                                  testResult: null,
                                  testError: null,
                                };
                                setFormSources(updated);
                              }}
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            >
                              <option value="rss">RSS Feed</option>
                              <option value="youtube">YouTube Channel</option>
                              <option value="reddit">Subreddit</option>
                              <option value="html">Custom HTML Scraper</option>
                              <option value="fourchan">4chan Search</option>
                            </select>
                          </div>

                          <div className={source.type === 'youtube' ? 'col-span-5' : 'col-span-7'}>
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">
                              {source.type === 'youtube' ? 'Channel URL or Handle' : source.type === 'reddit' ? 'Subreddit name / URL' : 'Website or RSS Feed URL'}
                            </label>
                            <input
                              type="text"
                              required
                              autoFocus={index === 0 && !source.url && !source.id}
                              value={source.url}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = { ...source, url: e.target.value };
                                setFormSources(updated);
                              }}
                              placeholder={
                                source.type === 'youtube' ? 'https://www.youtube.com/@t3dotgg' : 
                                source.type === 'reddit' ? 'r/javascript' : 'https://example.com/blog'
                              }
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          {source.type === 'youtube' && (
                            <div className="col-span-2 flex items-center justify-center pb-2">
                              <label className="flex items-center cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={source.config?.includeShorts !== false}
                                  onChange={(e) => {
                                    const updated = [...formSources];
                                    updated[index] = {
                                      ...source,
                                      config: { ...source.config, includeShorts: e.target.checked },
                                    };
                                    setFormSources(updated);
                                  }}
                                  className="rounded border-gray-300 dark:border-gray-700 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5"
                                />
                                <span className="ml-1.5 text-xs font-semibold text-gray-650 dark:text-gray-350">Shorts</span>
                              </label>
                            </div>
                          )}

                          <div className="col-span-2 pb-0.5">
                            <button
                              type="button"
                              disabled={source.testing || !source.url}
                              onClick={() => handleTestSource(index)}
                              className="w-full bg-white border border-gray-350 text-gray-650 hover:bg-gray-50 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300 font-semibold py-1.5 px-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed text-xs transition flex items-center justify-center space-x-1"
                            >
                              {source.testing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Link className="w-3.5 h-3.5" />}
                              <span>Test</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-12 gap-3 pr-6 items-end">
                          <div className="col-span-3">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Source Type</label>
                            <select
                              value={source.type}
                              onChange={(e) => {
                                const newType = e.target.value as FeedType;
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  type: newType,
                                  config: getInitialConfigForType(newType),
                                  url: '',
                                  testResult: null,
                                  testError: null,
                                };
                                setFormSources(updated);
                              }}
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            >
                              <option value="rss">RSS Feed</option>
                              <option value="youtube">YouTube Channel</option>
                              <option value="reddit">Subreddit</option>
                              <option value="html">Custom HTML Scraper</option>
                              <option value="fourchan">4chan Search</option>
                            </select>
                          </div>

                          <div className="col-span-2">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Board</label>
                            <input
                              type="text"
                              required
                              autoFocus={index === 0 && !source.id && (!source.config?.board || source.config?.board === 'g')}
                              value={source.config?.board || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, board: e.target.value.toLowerCase().trim() },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="g, v, a"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div className="col-span-3">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Search Query</label>
                            <input
                              type="text"
                              required
                              value={source.config?.query || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, query: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="setup, linux"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div className="col-span-2">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Max Threads</label>
                            <input
                              type="number"
                              min="1"
                              max="50"
                              value={source.config?.topN || 10}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, topN: parseInt(e.target.value) || 10 },
                                };
                                setFormSources(updated);
                              }}
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div className="col-span-2 pb-0.5">
                            <button
                              type="button"
                              disabled={source.testing}
                              onClick={() => handleTestSource(index)}
                              className="w-full bg-white border border-gray-350 text-gray-650 hover:bg-gray-50 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300 font-semibold py-1.5 px-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed text-xs transition flex items-center justify-center space-x-1"
                            >
                              {source.testing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Link className="w-3.5 h-3.5" />}
                              <span>Test</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Existing source: schedule, failures and manual refresh */}
                      {source.id && (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {source.nextRefreshAt
                              ? `Next check ${formatDate(source.nextRefreshAt)}`
                              : 'Auto-refresh off'}
                          </span>
                          <span>Last ok: {formatDate(source.lastFetched ?? null)}</span>
                          {(source.consecutiveFailures ?? 0) > 0 && (
                            <span
                              className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 font-semibold"
                              title={source.lastError || 'Last fetch failed'}
                            >
                              <AlertCircle className="w-3 h-3" />
                              {source.consecutiveFailures} failure
                              {(source.consecutiveFailures ?? 0) > 1 ? 's' : ''}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRefreshSource(source.id!)}
                            disabled={refreshingSourceId === source.id}
                            className="inline-flex items-center gap-1 font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 disabled:opacity-50 transition"
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${refreshingSourceId === source.id ? 'animate-spin' : ''}`}
                            />
                            Refresh now
                          </button>
                        </div>
                      )}

                      {/* Compact Selector Inputs for Custom HTML */}
                      {source.type === 'html' && (
                        <div className="grid grid-cols-5 gap-2 mt-2 bg-white dark:bg-gray-900/60 p-2.5 rounded-lg border border-gray-200 dark:border-gray-800">
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Container CSS *</label>
                            <input
                              type="text"
                              required
                              value={source.config?.itemSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, itemSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder=".post-item"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-250 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Title CSS *</label>
                            <input
                              type="text"
                              required
                              value={source.config?.titleSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, titleSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="h2"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-255 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Link CSS *</label>
                            <input
                              type="text"
                              required
                              value={source.config?.linkSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, linkSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="a"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-255 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Desc CSS</label>
                            <input
                              type="text"
                              value={source.config?.descriptionSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, descriptionSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder=".summary"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-255 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Date CSS</label>
                            <input
                              type="text"
                              value={source.config?.pubDateSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, pubDateSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="span.date"
                              className="w-full bg-white dark:bg-gray-805 border border-gray-250 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                        </div>
                      )}

                      {/* inline feedback blocks */}
                      {source.testError && (
                        <div className="bg-red-50 text-red-800 border border-red-200 p-2 rounded-lg text-[10px] dark:bg-red-950/20 dark:border-red-900/60 dark:text-red-400 mt-2">
                          {source.testError}
                        </div>
                      )}

                      {source.testResult && (
                        <div className="border border-green-200 dark:border-green-900 bg-green-50/20 dark:bg-green-950/5 p-2 rounded-lg text-[10px] max-h-24 overflow-y-auto mt-2">
                          <span className="font-bold text-green-700 dark:text-green-400 block mb-1">
                            Success! Found {source.testResult.count} items:
                          </span>
                          <ul className="list-disc pl-4 space-y-0.5 text-gray-500">
                            {source.testResult.items.slice(0, 3).map((item, i) => (
                              <li key={i} className="truncate">{item.title}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="border-t border-gray-200 dark:border-gray-800 pt-4 flex justify-end space-x-3 bg-gray-50 dark:bg-gray-900/50 -mx-6 -mb-6 px-6 py-4 mt-6">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 font-semibold text-sm rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm rounded-lg shadow-sm transition disabled:opacity-50 flex items-center space-x-1.5"
                >
                  {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{saving ? (editingFeed ? 'Saving...' : 'Registering...') : (editingFeed ? 'Save Changes' : 'Register Feed')}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
