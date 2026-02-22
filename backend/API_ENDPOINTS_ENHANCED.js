/**
 * BACKEND API REFERENCE
 * Base URL: http://localhost:5000/api
 */

const API_ENDPOINTS = {
  FARMER: {
    // POST: { farmer_id, crop_name, description, base_price }
    CREATE_LISTING: '/farmer/listing', 
    
    // POST: multipart/form-data with 'image' field
    UPLOAD_PICTURE: (listingId) => `/farmer/listing/${listingId}/upload`, 
  },
  
  TRADER: {
    // POST: { listing_id, trader_id, amount }
    PLACE_BID: '/trader/bid',
    
    // POST: { bid_id, trader_id, reason }
    RAISE_DISPUTE: '/trader/dispute',
  },
  
  ADMIN: {
    // GET: Fetch all open disputes
    GET_DISPUTES: '/admin/disputes',
    
    // PUT: { resolution_notes, admin_id }
    RESOLVE_DISPUTE: (disputeId) => `/admin/dispute/${disputeId}/resolve`,
    
    // POST: multipart/form-data with 'csv' file and 'admin_id' text field
    // CSV Format requires headers: bid_id, new_amount
    UPLOAD_CSV: '/admin/upload-bids-csv',
  }
};

export default API_ENDPOINTS;

/* NOTE ON REAL-TIME: 
  For real-time updates in the Admin Portal (listening for new disputes) and Farmer Portal 
  (listening for new bids), the React frontend should still use the Supabase JS Client 
  `supabase.channel('public:disputes').on('postgres_changes', ...)` directly to subscribe 
  to WebSocket events, avoiding constant polling to this Express API. 
*/