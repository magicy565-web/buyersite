ALTER TABLE buyer_enquiries ADD COLUMN context_json TEXT;
--> statement-breakpoint
ALTER TABLE buyer_enquiries ADD COLUMN originating_page_path TEXT;
--> statement-breakpoint
ALTER TABLE buyer_enquiries ADD COLUMN landing_page_path TEXT;
--> statement-breakpoint
ALTER TABLE buyer_enquiries ADD COLUMN attribution_method TEXT;
--> statement-breakpoint
CREATE INDEX buyer_enquiries_origin ON buyer_enquiries (site_slug, originating_page_path, created_at);
