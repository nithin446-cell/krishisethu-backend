-- Ensure extensions for UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Common users table
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role VARCHAR(50) CHECK (role IN ('admin', 'farmer', 'trader')),
    full_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Crop Listings (FIXED: Added variety, quantity, unit, location)
CREATE TABLE IF NOT EXISTS public.crop_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id UUID REFERENCES public.users(id),
    crop_name TEXT NOT NULL,
    variety TEXT,
    quantity DECIMAL(10, 2) NOT NULL,
    unit VARCHAR(20) DEFAULT 'quintal',
    base_price DECIMAL(10, 2) NOT NULL,
    location TEXT NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Crop Pictures
CREATE TABLE IF NOT EXISTS public.crop_pictures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID REFERENCES public.crop_listings(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bids (FIXED: Added quantity and message)
CREATE TABLE IF NOT EXISTS public.bids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID REFERENCES public.crop_listings(id),
    trader_id UUID REFERENCES public.users(id),
    amount DECIMAL(10, 2) NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL,
    message TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Disputes
CREATE TABLE IF NOT EXISTS public.disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bid_id UUID REFERENCES public.bids(id),
    trader_id UUID REFERENCES public.users(id),
    reason TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'open',
    resolution_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bid History for CSV Updates
CREATE TABLE IF NOT EXISTS public.bid_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bid_id UUID REFERENCES public.bids(id),
    historical_amount DECIMAL(10, 2),
    updated_by UUID REFERENCES public.users(id),
    upload_batch_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Admin Logs
CREATE TABLE IF NOT EXISTS public.admin_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES public.users(id),
    action TEXT NOT NULL,
    target_table TEXT,
    target_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Realtime for the Admin Portal
ALTER PUBLICATION supabase_realtime ADD TABLE disputes;
-- Add missing columns for complete user profiles
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
ADD COLUMN IF NOT EXISTS location TEXT,
ADD COLUMN IF NOT EXISTS business_name TEXT;