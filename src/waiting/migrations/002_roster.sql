DROP INDEX waiting_requests_unique_active;
CREATE INDEX waiting_requests_roster ON waiting_requests (restaurant_id, visit_date, slot)
  WHERE state NOT IN ('CANCELLED','FAILED','EXPIRED');
