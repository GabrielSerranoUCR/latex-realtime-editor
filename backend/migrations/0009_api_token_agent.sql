-- Which AI client a token is used by, as it announced itself (the MCP client's own name, sent on its first request).
-- Kept from the first announcement; NULL until the token has been used by an MCP client.
ALTER TABLE api_tokens ADD COLUMN agent TEXT;
