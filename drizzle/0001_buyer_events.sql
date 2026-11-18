CREATE TABLE buyer_event_daily (
  site_slug TEXT NOT NULL,
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  path TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_slug, day, event, path)
);
