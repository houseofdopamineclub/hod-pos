// hodclub.in customer-wallet — Firestore-backed menu loader.
//
// Drop-in replacement for the hardcoded HOD_FOOD_MENU / HOD_BAR_MENU /
// HOD_SMOKE_MENU arrays in hod-wallet-v3-PREVIEW.html. Once published, the
// admin POS (artifacts/pos-system, "📋 Menu Editor" tab) becomes the single
// source of truth for what the customer sees.
//
// Usage in the wallet (index.html):
//   1. Load Firebase modular SDK (already loaded for wallet-recharge).
//   2. Replace the var HOD_FOOD_MENU = [...]; ... HOD_SMOKE_MENU = [...]; block
//      with: <script src="menu-firestore.js"></script>  (this file).
//   3. The existing hodGetMenuByTab(tab) call sites keep working — this file
//      defines window.HOD_FOOD_MENU / HOD_BAR_MENU / HOD_SMOKE_MENU and a
//      compatible hodGetMenuByTab(). On first call they are seeded from the
//      cached snapshot so the FIRST PAINT is instant; the live Firestore
//      listener then patches them in place when fresh data arrives.
//
// Cache strategy:
//   - localStorage key `hod.venueMenu.v1.{tabId}` holds the last good copy
//     plus a timestamp (`ts`).
//   - On boot we paint from cache (if any), else from baked-in fallback.
//   - We open a snapshot listener; every push overwrites cache + arrays.
//   - Offline (Firestore listener errors / SDK missing) → keep showing the
//     cached / fallback list. The wallet stays usable without connectivity.
//
// Schema written by the POS:
//   venueMenu/{food|liquor|nab|smoke} = {
//     tabId, categories: [ { cat, items: [ {n,p,t,alc,v?,oos?,sub?} ] } ],
//     updatedBy, updatedAt
//   }
//
// Firestore rules: see customer-wallet/README.md. Do NOT use a bare
// `allow write: if request.auth != null` — anonymous auth makes that
// effectively world-writable. Require a `posManager` custom claim or a
// UID allowlist (the README ships both examples).

(function () {
  'use strict';
  var TABS = ['food', 'liquor', 'nab', 'smoke'];
  var CACHE_KEY = function (t) { return 'hod.venueMenu.v1.' + t; };

  // ── 1. BAKED-IN FALLBACK ────────────────────────────────────────────────
  // These are the ORIGINAL hardcoded arrays. Kept verbatim so a fresh device
  // with no cache and no network still shows a usable menu. When the venue
  // first publishes via the POS editor, the cache + live listener take over.
  // The wallet's existing search / filter / GST math reads these globals.
  // Verbatim copy of the original hodclub.in arrays (hod-wallet-v3-PREVIEW.html
    // lines 649-668). Kept as the offline-safe fallback so a fresh device with
    // no cache and no network still shows a usable menu.
    var FALLBACK_FOOD = [{"cat":"Misc","items":[{"n":"Mushroom Cappuccino Soup","p":228,"t":"food","alc":false,"v":true},{"n":"Tomato Basil Soup","p":185,"t":"food","alc":false,"v":true},{"n":"Manchow Soup - Veg","p":185,"t":"food","alc":false,"v":true},{"n":"Manchow Soup - Chicken","p":228,"t":"food","alc":false,"v":false}]},{"cat":"Salads","items":[{"n":"Indian Farmhouse Salad","p":235,"t":"food","alc":false,"v":true},{"n":"Caesar Sald Veg","p":285,"t":"food","alc":false,"v":true},{"n":"Caesar Salad Chicken","p":299,"t":"food","alc":false,"v":false},{"n":"Watermelon Feta Salad","p":285,"t":"food","alc":false,"v":true},{"n":"Booster Salad Veg","p":235,"t":"food","alc":false,"v":true},{"n":"Booster Salad Chicken","p":299,"t":"food","alc":false,"v":false}]},{"cat":"Bar Bites","items":[{"n":"Salted French Fries","p":235,"t":"food","alc":false,"v":true},{"n":"Peri Peri French Fries","p":285,"t":"food","alc":false,"v":true},{"n":"Corn Salt & Pepper","p":295,"t":"food","alc":false,"v":true},{"n":"Noughty Nutties","p":299,"t":"food","alc":false,"v":true},{"n":"Bbq Style Cajun Potato","p":299,"t":"food","alc":false,"v":true},{"n":"Peanut Masala","p":299,"t":"food","alc":false,"v":true},{"n":"Egg Pakoda","p":199,"t":"food","alc":false,"v":false},{"n":"Egg Bhurji","p":199,"t":"food","alc":false,"v":false},{"n":"Boild Egg","p":149,"t":"food","alc":false,"v":false}]},{"cat":"Chaat","items":[{"n":"Chicken Tikka Chick Peas Chat","p":329,"t":"food","alc":false,"v":false},{"n":"Nipattu Avocado Chat","p":329,"t":"food","alc":false,"v":true}]},{"cat":"Chargrilled","items":[{"n":"Harissa Paneer Tikka","p":410,"t":"food","alc":false,"v":true},{"n":"Chimichuri Paneer Tikka","p":405,"t":"food","alc":false,"v":true},{"n":"Zafran Malai Brocolli","p":375,"t":"food","alc":false,"v":true},{"n":"Tahina Stuffed Mushroom","p":401,"t":"food","alc":false,"v":true},{"n":"Guntur Chicken Tikka","p":405,"t":"food","alc":false,"v":false},{"n":"Asian Chicken Tikka","p":405,"t":"food","alc":false,"v":false},{"n":"Balsamic Pepper Chicken Tikka","p":405,"t":"food","alc":false,"v":false},{"n":"Mexicon Chilli Cheese Kabab","p":405,"t":"food","alc":false,"v":false},{"n":"Sole Fish Tikka","p":459,"t":"food","alc":false,"v":false},{"n":"Mutton Seekh Kabab With Pita","p":499,"t":"food","alc":false,"v":false},{"n":"Moilee Prawns Tandoori","p":565,"t":"food","alc":false,"v":false},{"n":"Pindiwala Bhatti Da Murgh","p":475,"t":"food","alc":false,"v":false},{"n":"Peri Peri Tandoori Wings","p":401,"t":"food","alc":false,"v":false},{"n":"Murgh Malai Tikka","p":399,"t":"food","alc":false,"v":false}]},{"cat":"Platters","items":[{"n":"Veg Platters","p":1499,"t":"food","alc":false,"v":true},{"n":"Nonveg Platters","p":2299,"t":"food","alc":false,"v":false}]},{"cat":"Oriental","items":[{"n":"Togorasi Lotus Stem Chips","p":325,"t":"food","alc":false,"v":true},{"n":"Tangy Mushroom","p":299,"t":"food","alc":false,"v":true},{"n":"Cheese Wonton","p":401,"t":"food","alc":false,"v":true},{"n":"Korean Chilli Potato","p":299,"t":"food","alc":false,"v":true},{"n":"Roasted Brussels And Tofu","p":401,"t":"food","alc":false,"v":true},{"n":"Stir Fried Mushroom And Broccoli With Bok Choy","p":401,"t":"food","alc":false,"v":true},{"n":"Schezwan Cottage Cheese","p":349,"t":"food","alc":false,"v":true},{"n":"Egg Chilli","p":249,"t":"food","alc":false,"v":false},{"n":"Chicken Tikka Chilli","p":401,"t":"food","alc":false,"v":false},{"n":"Drums Of Heaven","p":399,"t":"food","alc":false,"v":false},{"n":"Beer Chilli Chicken","p":401,"t":"food","alc":false,"v":false},{"n":"Steamed Fish","p":409,"t":"food","alc":false,"v":false},{"n":"Chicken Techha","p":399,"t":"food","alc":false,"v":false},{"n":"Asian Style Lemon Chicken With Long Beans","p":399,"t":"food","alc":false,"v":false}]},{"cat":"Bao","items":[{"n":"Chilli Cilantro Mushroom Bao","p":375,"t":"food","alc":false,"v":true},{"n":"Korean Chicken Bao","p":401,"t":"food","alc":false,"v":false},{"n":"Tempura Tofu Bao","p":399,"t":"food","alc":false,"v":false}]},{"cat":"Dimsum","items":[{"n":"Veg Gyoza","p":299,"t":"food","alc":false,"v":true},{"n":"Chicken Gyoza","p":329,"t":"food","alc":false,"v":false},{"n":"Veg Chilli Oil Dumpling","p":399,"t":"food","alc":false,"v":true},{"n":"Spicy Celery Chicken Dimsum","p":405,"t":"food","alc":false,"v":false}]},{"cat":"International Starters","items":[{"n":"Corn Ribs","p":290,"t":"food","alc":false,"v":false},{"n":"Nachos Veg","p":299,"t":"food","alc":false,"v":true},{"n":"Crisy Fried Onion Ring","p":285,"t":"food","alc":false,"v":true},{"n":"Tex -Mex Cheese Poppers","p":401,"t":"food","alc":false,"v":true},{"n":"Peri Peri Grilled Paneer","p":401,"t":"food","alc":false,"v":true},{"n":"Babycorn Fritters","p":299,"t":"food","alc":false,"v":true},{"n":"Paneer Fritters","p":399,"t":"food","alc":false,"v":true},{"n":"Cheese Garlic Bread","p":285,"t":"food","alc":false,"v":true},{"n":"Pull Apart Cheese Bread","p":299,"t":"food","alc":false,"v":true},{"n":"Butter Garlic Mushroom & Brocolli","p":349,"t":"food","alc":false,"v":true},{"n":"Nachos Chicken","p":349,"t":"food","alc":false,"v":false},{"n":"Avocado Ricotta Chicken Crostini","p":319,"t":"food","alc":false,"v":false},{"n":"Hot & Spicy Chicken Wings","p":401,"t":"food","alc":false,"v":false},{"n":"Chicken Popcorn","p":349,"t":"food","alc":false,"v":false},{"n":"Crunchy Threaded Chicken","p":349,"t":"food","alc":false,"v":false},{"n":"Butter Garlic Prawns & Brocolli","p":459,"t":"food","alc":false,"v":false},{"n":"Fish & Chips","p":519,"t":"food","alc":false,"v":false}]},{"cat":"Pasta","items":[{"n":"Alfredo Sauce Penne Pasta Veg","p":509,"t":"food","alc":false,"v":true},{"n":"Alfredo Sauce Penne Pasta Chicken","p":509,"t":"food","alc":false,"v":false},{"n":"Arrabiata Sauce Penne Pasta Veg","p":399,"t":"food","alc":false,"v":true},{"n":"Arrabiata Sauce Penne Pasta Chicken","p":509,"t":"food","alc":false,"v":false},{"n":"Spaghetti Aglio E Olio Veg","p":399,"t":"food","alc":false,"v":true},{"n":"Spaghetti Aglio E Olio Chicken","p":509,"t":"food","alc":false,"v":false},{"n":"Spaghetti Pesto Sauce Veg","p":399,"t":"food","alc":false,"v":true},{"n":"Spaghetti Pesto Sauce Chicken","p":509,"t":"food","alc":false,"v":false}]},{"cat":"International Mains","items":[{"n":"Grilled Chicken With Mushroom Pepper Sauce","p":401,"t":"food","alc":false,"v":true},{"n":"Grilled Fish With Lemon Butter Sauce","p":449,"t":"food","alc":false,"v":false}]},{"cat":"Coastal","items":[{"n":"Ghee Roast Mushroom","p":349,"t":"food","alc":false,"v":true},{"n":"Ghee Roast Paneer","p":401,"t":"food","alc":false,"v":true},{"n":"Ghee Roast Egg","p":305,"t":"food","alc":false,"v":true},{"n":"Ghee Roast Chicken","p":405,"t":"food","alc":false,"v":false},{"n":"Ghee Roast Mutton","p":519,"t":"food","alc":false,"v":false},{"n":"Ghee Roast Prawns","p":559,"t":"food","alc":false,"v":false},{"n":"Natti Style Pepper Fry Mushroom","p":401,"t":"food","alc":false,"v":true},{"n":"Natti Style Pepper Fry Paneer","p":401,"t":"food","alc":false,"v":true},{"n":"Natti Style Egg Pepper Dry","p":305,"t":"food","alc":false,"v":true},{"n":"Natti Style Pepper Fry Chicken","p":459,"t":"food","alc":false,"v":false},{"n":"Natti Style Pepper Fry Mutton","p":519,"t":"food","alc":false,"v":false},{"n":"Natti Style Pepper Fry Prawns","p":569,"t":"food","alc":false,"v":false},{"n":"Mushroom Urval","p":401,"t":"food","alc":false,"v":true},{"n":"Paneer Urval","p":401,"t":"food","alc":false,"v":true},{"n":"Chicken Urval","p":405,"t":"food","alc":false,"v":false},{"n":"Mutton Urval","p":519,"t":"food","alc":false,"v":false},{"n":"Pranws Urval","p":519,"t":"food","alc":false,"v":false},{"n":"Cashew Curry Leaf Paneer","p":401,"t":"food","alc":false,"v":true},{"n":"Cashew Curry Leaf Chicken","p":401,"t":"food","alc":false,"v":false}]},{"cat":"Pizza","items":[{"n":"Italian Veggie Pizza","p":516,"t":"food","alc":false,"v":true},{"n":"Clasic Margarita","p":509,"t":"food","alc":false,"v":true},{"n":"Mushroom Corn Pizza","p":516,"t":"food","alc":false,"v":true},{"n":"Bbq Chicken Pizza","p":629,"t":"food","alc":false,"v":false},{"n":"Fiery Chicken Pizza","p":629,"t":"food","alc":false,"v":false},{"n":"Pesto Seafood Pizza","p":680,"t":"food","alc":false,"v":false}]},{"cat":"Main Course","items":[{"n":"Double Dal Tadka","p":239,"t":"food","alc":false,"v":true},{"n":"Sabji Meloni","p":299,"t":"food","alc":false,"v":true},{"n":"Kadai Paneer With Kamal Kakdi","p":401,"t":"food","alc":false,"v":true},{"n":"Paneer Khurchan","p":401,"t":"food","alc":false,"v":true},{"n":"Lasooni Palak Paneer","p":401,"t":"food","alc":false,"v":true},{"n":"Mushroom Chicken Ghotala","p":401,"t":"food","alc":false,"v":false},{"n":"Hod Special Chicken Curry","p":401,"t":"food","alc":false,"v":false},{"n":"Murgh Patiyala","p":401,"t":"food","alc":false,"v":false},{"n":"Kadai Chicken With Kamal Kakdi","p":401,"t":"food","alc":false,"v":false},{"n":"Palak Chicken","p":401,"t":"food","alc":false,"v":false},{"n":"Rogni Raiwala Meat","p":516,"t":"food","alc":false,"v":false},{"n":"Manglorean Style Fish Curry","p":649,"t":"food","alc":false,"v":false},{"n":"Manglorean Style Pomfret Fish","p":649,"t":"food","alc":false,"v":false},{"n":"Manglorean Style Kane Fish Curry","p":399,"t":"food","alc":false,"v":false},{"n":"Silken Tofu Cubs Vibrant And Spicy Schezwan Sauce With Jasmine Rice","p":419,"t":"food","alc":false,"v":false},{"n":"Massaman Curry Veg With Jasmine Rice","p":401,"t":"food","alc":false,"v":false},{"n":"Massaman Curry Chicken With Jasmine Rice","p":425,"t":"food","alc":false,"v":false}]},{"cat":"Biryani & Rice","items":[{"n":"Steam Rice","p":179,"t":"food","alc":false,"v":true},{"n":"Jeera Rice","p":179,"t":"food","alc":false,"v":true},{"n":"Curd Rice","p":229,"t":"food","alc":false,"v":true},{"n":"Dal Kichdi","p":249,"t":"food","alc":false,"v":true},{"n":"Palak Kichdi","p":249,"t":"food","alc":false,"v":true},{"n":"Veg Biryani","p":349,"t":"food","alc":false,"v":true},{"n":"Chicken Dum Biryani","p":401,"t":"food","alc":false,"v":false},{"n":"Mutton Biryani","p":520,"t":"food","alc":false,"v":false}]},{"cat":"Rice & Noodles","items":[{"n":"Veg Fried Rice","p":299,"t":"food","alc":false,"v":true},{"n":"Egg Fried Rice","p":285,"t":"food","alc":false,"v":false},{"n":"Chicken Fried Rice","p":359,"t":"food","alc":false,"v":false},{"n":"Schezwan Veg Fried Rice -","p":299,"t":"food","alc":false,"v":true},{"n":"Schezwan Egg Fried Rice","p":285,"t":"food","alc":false,"v":false},{"n":"Schezwan Chicken Fried Rice","p":359,"t":"food","alc":false,"v":false},{"n":"Brunt Garlic Cilantro Fried Rice - Veg","p":299,"t":"food","alc":false,"v":true},{"n":"Brunt Garlic Cilantro Fried Rice - Egg","p":285,"t":"food","alc":false,"v":false},{"n":"Brunt Garlic Cilantro Fried Rice - Chicken","p":359,"t":"food","alc":false,"v":false},{"n":"Hakka Noodle - Veg","p":299,"t":"food","alc":false,"v":true},{"n":"Hakka Noodle - Egg","p":285,"t":"food","alc":false,"v":false},{"n":"Hakka Noodle - Chicken","p":359,"t":"food","alc":false,"v":false},{"n":"Schezwan Noodle - Veg","p":299,"t":"food","alc":false,"v":true},{"n":"Schezwan Noodle - Egg","p":285,"t":"food","alc":false,"v":false},{"n":"Schezwan Noodle - Chicken","p":359,"t":"food","alc":false,"v":false},{"n":"Brunt Garlic Cilantro Noodles - Veg","p":299,"t":"food","alc":false,"v":true},{"n":"Brunt Garlic Cilantro Noodles - Egg","p":285,"t":"food","alc":false,"v":false},{"n":"Brunt Garlic Cilantro Noodles Chicken","p":359,"t":"food","alc":false,"v":false}]},{"cat":"Breads","items":[{"n":"Roti - Plain","p":55,"t":"food","alc":false,"v":true},{"n":"Roti - Butter","p":65,"t":"food","alc":false,"v":true},{"n":"Roti - Green Chilli","p":65,"t":"food","alc":false,"v":true},{"n":"Naan - Plain","p":75,"t":"food","alc":false,"v":true},{"n":"Naan - Butter","p":79,"t":"food","alc":false,"v":true},{"n":"Naan - Garlic","p":79,"t":"food","alc":false,"v":true},{"n":"Cheese Garlic Naan","p":125,"t":"food","alc":false,"v":true},{"n":"Lachha Parantha - Plain","p":75,"t":"food","alc":false,"v":true},{"n":"Lachha Parantha - Butter","p":79,"t":"food","alc":false,"v":true},{"n":"Lachha Parantha - Pudina","p":79,"t":"food","alc":false,"v":true},{"n":"Kulcha - Plain","p":59,"t":"food","alc":false,"v":true},{"n":"Kulcha - Butter","p":69,"t":"food","alc":false,"v":true}]},{"cat":"Desserts","items":[{"n":"Sizzling Brownie With Ice Cream","p":399,"t":"food","alc":false,"v":true},{"n":"Coconut Caramel Custard","p":299,"t":"food","alc":false,"v":true},{"n":"Pistachio Tres Laches","p":299,"t":"food","alc":false,"v":true},{"n":"Tirsamisu Pull Me Up","p":399,"t":"food","alc":false,"v":true},{"n":"Lotus Biscoff Cheese Cake","p":399,"t":"food","alc":false,"v":true},{"n":"Chilli Gauva Ice Cream","p":279,"t":"food","alc":false,"v":true},{"n":"Gilkond Ice Cream","p":279,"t":"food","alc":false,"v":true},{"n":"Vanilla Ice Cream","p":229,"t":"food","alc":false,"v":true}]}];
    var FALLBACK_BAR  = [{"cat":"Fresh Craft Beer","items":[{"n":"Toit Tint Wit (330 Ml)","p":402,"t":"drink","alc":true},{"n":"Toit Tint Wit (500 Ml)","p":517,"t":"drink","alc":true},{"n":"Toit Tint Wit (Pitcher)","p":1380,"t":"drink","alc":true},{"n":"Toit Tint Wit (Tower)","p":2530,"t":"drink","alc":true},{"n":"Toit Hefeweizen (330Ml)","p":410,"t":"drink","alc":true},{"n":"Toit Hefeweizen (500 Ml)","p":530,"t":"drink","alc":true},{"n":"Toit Hefeweizen (Pitcher)","p":1499,"t":"drink","alc":true},{"n":"Toit Hefeweizen (Tower)","p":2650,"t":"drink","alc":true}]},{"cat":"Breezers","items":[{"n":"Cranberry","p":422,"t":"drink","alc":true},{"n":"Orange","p":422,"t":"drink","alc":true},{"n":"Jamaican Passion","p":422,"t":"drink","alc":true},{"n":"Watermellon","p":422,"t":"drink","alc":true}]},{"cat":"Bottle Beer","items":[{"n":"Kingfisher Ultra Wit","p":400,"t":"drink","alc":true},{"n":"Kingfisher Ultra Max","p":460,"t":"drink","alc":true},{"n":"Hoegaarden","p":520,"t":"drink","alc":true},{"n":"Corona","p":570,"t":"drink","alc":true},{"n":"Heiniken","p":520,"t":"drink","alc":true},{"n":"Budwiser Magnum","p":460,"t":"drink","alc":true},{"n":"Budwiser Premium","p":400,"t":"drink","alc":true},{"n":"Kingfisher Ultra","p":400,"t":"drink","alc":true},{"n":"Tuborg","p":400,"t":"drink","alc":true},{"n":"Bro Code","p":480,"t":"drink","alc":true},{"n":"Boroka Gin & Tonic","p":450,"t":"drink","alc":true},{"n":"Panthera","p":480,"t":"drink","alc":true}]},{"cat":"Can Beer (330ml)","items":[{"n":"Budwiser Magnum","p":399,"t":"drink","alc":true},{"n":"Budwiser Preimum","p":379,"t":"drink","alc":true}]},{"cat":"Can Beer (500ml)","items":[{"n":"Kingfisher Ultra","p":600,"t":"drink","alc":true},{"n":"Kingfisher Ultra Max","p":380,"t":"drink","alc":true}]},{"cat":"Single Malt","items":[{"n":"Amruth Fusion (30ml)","p":862,"t":"drink","alc":true},{"n":"Amruth Fusion (Bottle)","p":17250,"t":"drink","alc":true},{"n":"Jack Daniels Single Barrle (30ml)","p":920,"t":"drink","alc":true},{"n":"Jack Daniels Single Barrle (Bottle)","p":18400,"t":"drink","alc":true},{"n":"Glenlivet 12 Yrs (30ml)","p":918,"t":"drink","alc":true},{"n":"Glenlivet 12 Yrs (Bottle)","p":18360,"t":"drink","alc":true},{"n":"Glenfiddich 12 Yrs (30ml)","p":850,"t":"drink","alc":true},{"n":"Glenfiddich 12 Yrs (Bottle)","p":17000,"t":"drink","alc":true},{"n":"Jura (30ml)","p":810,"t":"drink","alc":true},{"n":"Jura (Bottle)","p":16200,"t":"drink","alc":true},{"n":"Laphroaig 10 Yrs (30ml)","p":805,"t":"drink","alc":true},{"n":"Laphroaig 10 Yrs (Bottle)","p":16100,"t":"drink","alc":true},{"n":"Paul John Mithuna (30ml)","p":2250,"t":"drink","alc":true},{"n":"Paul John Mithuna (Bottle)","p":45000,"t":"drink","alc":true},{"n":"Paul John Nirvana (30ml)","p":529,"t":"drink","alc":true},{"n":"Paul John Nirvana (Bottle)","p":10580,"t":"drink","alc":true},{"n":"Paul John Brilliance (30ml)","p":529,"t":"drink","alc":true},{"n":"Paul John Brilliance (Bottle)","p":10580,"t":"drink","alc":true}]},{"cat":"American/Irish Whisky","items":[{"n":"Jack Daniels (30ml)","p":719,"t":"drink","alc":true},{"n":"Jack Daniels (Bottle)","p":14380,"t":"drink","alc":true},{"n":"Jim Beam (30ml)","p":550,"t":"drink","alc":true},{"n":"Jim Beam (Bottle)","p":11000,"t":"drink","alc":true},{"n":"Jameson (30ml)","p":559,"t":"drink","alc":true},{"n":"Jameson (Bottle)","p":11180,"t":"drink","alc":true}]},{"cat":"Scotch & IMFL Whisky","items":[{"n":"Jw Blue Lable (30ml)","p":1700,"t":"drink","alc":true},{"n":"Jw Blue Lable (Bottle)","p":34000,"t":"drink","alc":true},{"n":"Jw Gold Lable (30ml)","p":918,"t":"drink","alc":true},{"n":"Jw Gold Lable (Bottle)","p":18360,"t":"drink","alc":true},{"n":"Jw Double Black (30ml)","p":902,"t":"drink","alc":true},{"n":"Jw Double Black (Bottle)","p":18040,"t":"drink","alc":true},{"n":"Chivas Regal (30ml)","p":823,"t":"drink","alc":true},{"n":"Chivas Regal (Bottle)","p":16460,"t":"drink","alc":true},{"n":"Jw Red Lable (30ml)","p":550,"t":"drink","alc":true},{"n":"Jw Red Lable (Bottle)","p":11000,"t":"drink","alc":true},{"n":"Ballentine (30ml)","p":450,"t":"drink","alc":true},{"n":"Ballentine (Bottle)","p":9000,"t":"drink","alc":true},{"n":"Black And White (30ml)","p":410,"t":"drink","alc":true},{"n":"Black And White (Bottle)","p":8200,"t":"drink","alc":true},{"n":"Teachers 50 (30ml)","p":440,"t":"drink","alc":true},{"n":"Teachers 50 (Bottle)","p":8800,"t":"drink","alc":true},{"n":"Teachers Highland Cream (30ml)","p":370,"t":"drink","alc":true},{"n":"Teachers Highland Cream (Bottle)","p":7400,"t":"drink","alc":true},{"n":"Black Dog Gold Reserve (30ml)","p":520,"t":"drink","alc":true},{"n":"Black Dog Gold Reserve (Bottle)","p":10400,"t":"drink","alc":true},{"n":"100 Pipers (30ml)","p":410,"t":"drink","alc":true},{"n":"100 Pipers (Bottle)","p":8200,"t":"drink","alc":true},{"n":"Blenders Pride (30ml)","p":330,"t":"drink","alc":true},{"n":"Blenders Pride (Bottle)","p":6600,"t":"drink","alc":true},{"n":"Black Bottle (30ml)","p":510,"t":"drink","alc":true},{"n":"Black Bottle (Bottle)","p":10200,"t":"drink","alc":true},{"n":"Black Velvet (30ml)","p":460,"t":"drink","alc":true},{"n":"Black Velvet (Bottle)","p":9200,"t":"drink","alc":true},{"n":"Dewars 12 Yrs (30ml)","p":690,"t":"drink","alc":true},{"n":"Dewars 12 Yrs (Bottle)","p":13800,"t":"drink","alc":true},{"n":"Dewars White Lable (30ml)","p":410,"t":"drink","alc":true},{"n":"Dewars White Lable (Bottle)","p":8200,"t":"drink","alc":true},{"n":"Evan Williams (30ml)","p":500,"t":"drink","alc":true},{"n":"Evan Williams (Bottle)","p":10000,"t":"drink","alc":true},{"n":"Jw Blonde (30ml)","p":550,"t":"drink","alc":true},{"n":"Jw Blonde (Bottle)","p":11000,"t":"drink","alc":true},{"n":"J&B Rare (30ml)","p":460,"t":"drink","alc":true},{"n":"J&B Rare (Bottle)","p":9200,"t":"drink","alc":true},{"n":"Scottish Leader (30ml)","p":370,"t":"drink","alc":true},{"n":"Scottish Leader (Bottle)","p":7400,"t":"drink","alc":true},{"n":"Oak Smith (30ml)","p":317,"t":"drink","alc":true},{"n":"Oak Smith (Bottle)","p":6340,"t":"drink","alc":true}]},{"cat":"Vodka","items":[{"n":"Greey Goose (30ml)","p":895,"t":"drink","alc":true},{"n":"Greey Goose (Bottle)","p":17900,"t":"drink","alc":true},{"n":"Absolut (30ml)","p":460,"t":"drink","alc":true},{"n":"Absolut (Bottle)","p":9200,"t":"drink","alc":true},{"n":"Stoli (30ml)","p":600,"t":"drink","alc":true},{"n":"Stoli (Bottle)","p":12000,"t":"drink","alc":true},{"n":"Beluga (30ml)","p":1150,"t":"drink","alc":true},{"n":"Beluga (Bottle)","p":23000,"t":"drink","alc":true},{"n":"Smirnoff Red","p":400,"t":"drink","alc":true},{"n":"Smirnoff Mango Mirchi","p":400,"t":"drink","alc":true},{"n":"Smirnoff Jamun","p":400,"t":"drink","alc":true},{"n":"Smirnoff Lime","p":400,"t":"drink","alc":true},{"n":"Roberto Cavali (30ml)","p":1150,"t":"drink","alc":true},{"n":"Roberto Cavali (Bottle)","p":23000,"t":"drink","alc":true},{"n":"Zig Zag (30ml)","p":41,"t":"drink","alc":true},{"n":"Zig Zag (Bottle)","p":5000,"t":"drink","alc":true}]},{"cat":"Rum","items":[{"n":"Bacardi White","p":370,"t":"drink","alc":true},{"n":"Bacardi Lemon","p":370,"t":"drink","alc":true},{"n":"Bacardi Orange","p":370,"t":"drink","alc":true},{"n":"Old Monkk Dark","p":230,"t":"drink","alc":true},{"n":"Old Monkk Coffee","p":402,"t":"drink","alc":true}]},{"cat":"Gin","items":[{"n":"Bombay Sapphire (30ml)","p":608,"t":"drink","alc":true},{"n":"Bombay Sapphire (Bottle)","p":12160,"t":"drink","alc":true},{"n":"Beefeater (30ml)","p":510,"t":"drink","alc":true},{"n":"Beefeater (Bottle)","p":10200,"t":"drink","alc":true},{"n":"Great Indian Gin (30ml)","p":550,"t":"drink","alc":true},{"n":"Great Indian Gin (Bottle)","p":11000,"t":"drink","alc":true}]},{"cat":"Cognac & Brandy","items":[{"n":"Hennessey Vsop (30ml)","p":805,"t":"drink","alc":true},{"n":"Hennessey Vsop (Bottle)","p":16100,"t":"drink","alc":true},{"n":"Morpheus (30ml)","p":330,"t":"drink","alc":true},{"n":"Morpheus (Bottle)","p":6600,"t":"drink","alc":true},{"n":"Mansion House (30ml)","p":270,"t":"drink","alc":true},{"n":"Mansion House (Bottle)","p":5400,"t":"drink","alc":true}]},{"cat":"Tequila","items":[{"n":"Patron Silver (30ml)","p":1287,"t":"drink","alc":true},{"n":"Patron Silver (Bottle)","p":25740,"t":"drink","alc":true},{"n":"Jose Cuervo Silver (30ml)","p":575,"t":"drink","alc":true},{"n":"Jose Cuervo Silver (Bottle)","p":2300,"t":"drink","alc":true},{"n":"Camino Gold (30ml)","p":450,"t":"drink","alc":true},{"n":"Camino Gold (Bottle)","p":9240,"t":"drink","alc":true},{"n":"Camino Silver (30ml)","p":550,"t":"drink","alc":true},{"n":"Camino Silver (Bottle)","p":11000,"t":"drink","alc":true},{"n":"Desmondji 51 (30ml)","p":550,"t":"drink","alc":true},{"n":"Desmondji 51 (Bottle)","p":11000,"t":"drink","alc":true}]},{"cat":"Liqueurs","items":[{"n":"Absente 49 (30ml)","p":450,"t":"drink","alc":true},{"n":"Absente 49 (Bottle)","p":9000,"t":"drink","alc":true},{"n":"Jagermiester (30ml)","p":800,"t":"drink","alc":true},{"n":"Jagermiester (Bottle)","p":16000,"t":"drink","alc":true},{"n":"Jagermiester Orange (30ml)","p":800,"t":"drink","alc":true},{"n":"Jagermiester Orange (Bottle)","p":16000,"t":"drink","alc":true},{"n":"Baileys Irish Cream (30ml)","p":690,"t":"drink","alc":true},{"n":"Baileys Irish Cream (Bottle)","p":13800,"t":"drink","alc":true},{"n":"Sambucca (30ml)","p":450,"t":"drink","alc":true},{"n":"Sambucca (Bottle)","p":9000,"t":"drink","alc":true},{"n":"Kahlua Coffee Liqueur (30ml)","p":450,"t":"drink","alc":true},{"n":"Kahlua Coffee Liqueur (Bottle)","p":9000,"t":"drink","alc":true}]},{"cat":"Sparkling Wines","items":[{"n":"Chandon Brut","p":4025,"t":"drink","alc":true},{"n":"Sula Brut","p":4025,"t":"drink","alc":true}]},{"cat":"Wines","items":[{"n":"Jacob Greek Red \\ White (Glass)","p":690,"t":"drink","alc":true},{"n":"Jacob Greek Red \\ White (Bottle)","p":3450,"t":"drink","alc":true},{"n":"Sula Red \\ White \\ Rosse","p":575,"t":"drink","alc":true}]},{"cat":"Signature Mocktails","items":[{"n":"Innocent Passion","p":345,"t":"drink","alc":false},{"n":"Cassis Cooler","p":345,"t":"drink","alc":false},{"n":"Funky Toffy","p":345,"t":"drink","alc":false},{"n":"Paradise Iceland","p":345,"t":"drink","alc":false}]},{"cat":"Tall & Handsome","items":[{"n":"Bull Frog (Glass)","p":850,"t":"drink","alc":true},{"n":"Bull Frog (Bottle)","p":3000,"t":"drink","alc":true},{"n":"Long Island Ice Tea (Glass)","p":800,"t":"drink","alc":true},{"n":"Long Island Ice Tea (Bottle)","p":2800,"t":"drink","alc":true},{"n":"Long Beach Ice Tea (Glass)","p":800,"t":"drink","alc":true},{"n":"Long Beach Ice Tea (Bottle)","p":2800,"t":"drink","alc":true}]},{"cat":"Cocktails","items":[{"n":"Tequila Sunrise","p":650,"t":"drink","alc":true},{"n":"Margarita","p":630,"t":"drink","alc":true},{"n":"Martini","p":600,"t":"drink","alc":true},{"n":"Whisky Sour","p":570,"t":"drink","alc":true},{"n":"Sex On The Beach","p":570,"t":"drink","alc":true},{"n":"Cosmopolitan","p":570,"t":"drink","alc":true},{"n":"Pinacolada","p":575,"t":"drink","alc":true},{"n":"Mojito","p":575,"t":"drink","alc":true},{"n":"Daiquiri","p":575,"t":"drink","alc":true},{"n":"Mai Tai","p":575,"t":"drink","alc":true},{"n":"Cajun Kick","p":600,"t":"drink","alc":true}]},{"cat":"Tequila","items":[{"n":"Ginger War","p":555,"t":"drink","alc":true}]},{"cat":"Rum","items":[{"n":"Basil Blast","p":555,"t":"drink","alc":true}]},{"cat":"Vodka","items":[{"n":"Daddy Hod","p":555,"t":"drink","alc":true}]},{"cat":"Shooters","items":[{"n":"Jager Bomb / Orange","p":800,"t":"drink","alc":true},{"n":"B52","p":550,"t":"drink","alc":true},{"n":"Kamakazi","p":430,"t":"drink","alc":true},{"n":"Death Note","p":430,"t":"drink","alc":true},{"n":"Get Laid","p":430,"t":"drink","alc":true}]},{"cat":"Flamers","items":[{"n":"Flaming Lamborgini","p":2500,"t":"drink","alc":true},{"n":"Hod On Fire","p":2500,"t":"drink","alc":true}]},{"cat":"Mocktails","items":[{"n":"Virgin Mojito","p":345,"t":"drink","alc":false},{"n":"Virgin Colada","p":345,"t":"drink","alc":false},{"n":"Fruit Punch","p":345,"t":"drink","alc":false},{"n":"Ice Tea","p":345,"t":"drink","alc":false},{"n":"Guava Mary","p":345,"t":"drink","alc":false}]},{"cat":"Soft Drinks","items":[{"n":"Red Bull","p":350,"t":"drink","alc":false},{"n":"Ginger Ale","p":170,"t":"drink","alc":false},{"n":"Tonic Water","p":170,"t":"drink","alc":false},{"n":"Diet Coke","p":150,"t":"drink","alc":false},{"n":"Fresh Lime Soda","p":200,"t":"drink","alc":false},{"n":"Fresh Lime Water","p":150,"t":"drink","alc":false},{"n":"Canned Juices","p":170,"t":"drink","alc":false},{"n":"Coke","p":100,"t":"drink","alc":false},{"n":"Sprite","p":100,"t":"drink","alc":false},{"n":"Soda","p":75,"t":"drink","alc":false}]}];
    var FALLBACK_SMOKE = [{"cat":"Cigarettes","items":[{"n":"Cigarette 10 pc","p":460,"t":"drink","alc":false}]}];
    if (!window.HOD_FOOD_MENU || window.HOD_FOOD_MENU.length === 0) window.HOD_FOOD_MENU = FALLBACK_FOOD;
    if (!window.HOD_BAR_MENU  || window.HOD_BAR_MENU.length  === 0) window.HOD_BAR_MENU  = FALLBACK_BAR;
    if (!window.HOD_SMOKE_MENU || window.HOD_SMOKE_MENU.length === 0) window.HOD_SMOKE_MENU = FALLBACK_SMOKE;

  // Tag defaults (mirrors the existing wallet code).
  function tagFood(arr) { arr.forEach(function (c) { c.items.forEach(function (it) { if (it.t === undefined) it.t = 'food'; if (it.alc === undefined) it.alc = false; }); }); }
  function tagDrink(arr, alcDefault) { arr.forEach(function (c) { c.items.forEach(function (it) { if (it.t === undefined) it.t = 'drink'; if (it.alc === undefined) it.alc = alcDefault; }); }); }
  tagFood(window.HOD_FOOD_MENU);
  tagDrink(window.HOD_BAR_MENU, true);
  tagDrink(window.HOD_SMOKE_MENU, false);

  // ── 2. CACHE READ — paint instantly from last known good ────────────────
  function readCache(tabId) {
    try {
      var raw = localStorage.getItem(CACHE_KEY(tabId));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.categories)) return null;
      return parsed.categories;
    } catch (_) { return null; }
  }
  function writeCache(tabId, categories) {
    try { localStorage.setItem(CACHE_KEY(tabId), JSON.stringify({ ts: Date.now(), categories: categories })); }
    catch (_) { /* quota / disabled — fine, we'll re-fetch */ }
  }

  // Hide out-of-stock items from the customer wallet entirely.
  function stripOos(categories) {
    return categories.map(function (c) {
      return { cat: c.cat, items: (c.items || []).filter(function (it) { return !it.oos; }) };
    }).filter(function (c) { return c.items.length > 0; });
  }

  // Apply a categories[] payload to the wallet globals for the given tab.
  // The wallet renders FOOD and SMOKE directly; LIQUOR + NAB are merged
  // back into HOD_BAR_MENU because hodGetMenuByTab() splits BAR by `.alc`.
  function applyTab(tabId, categories) {
    var clean = stripOos(categories);
    if (tabId === 'food') {
      window.HOD_FOOD_MENU = clean;
      tagFood(window.HOD_FOOD_MENU);
    } else if (tabId === 'smoke') {
      window.HOD_SMOKE_MENU = clean;
      tagDrink(window.HOD_SMOKE_MENU, false);
    } else {
      // Rebuild HOD_BAR_MENU = (LIQUOR cache) + (NAB cache).
      var liquor = readCache('liquor') || [];
      var nab = readCache('nab') || [];
      var bar = stripOos(liquor).concat(stripOos(nab));
      window.HOD_BAR_MENU = bar;
      tagDrink(window.HOD_BAR_MENU, true);
      // Force `alc=false` for items coming from NAB so hodGetMenuByTab() splits correctly.
      var nabNames = {};
      stripOos(nab).forEach(function (c) { c.items.forEach(function (it) { nabNames[c.cat + '|' + it.n] = true; }); });
      window.HOD_BAR_MENU.forEach(function (c) {
        c.items.forEach(function (it) {
          if (nabNames[c.cat + '|' + it.n]) it.alc = false;
        });
      });
    }
    // Notify the wallet UI so it can re-render the active tab.
    try { window.dispatchEvent(new CustomEvent('hod:venueMenuUpdate', { detail: { tabId: tabId } })); } catch (_) {}
  }

  // ── 3. PRIME FROM CACHE on script load (synchronous) ────────────────────
  TABS.forEach(function (t) {
    var cached = readCache(t);
    if (cached) applyTab(t, cached);
  });

  // ── 4. LIVE LISTENER (best-effort) ──────────────────────────────────────
  // Wallet is expected to expose `window.firebaseDb` (Firestore instance) and
  // `window.firebaseFirestore` (the modular SDK namespace) — both already set
  // up for wallet-recharge. If either is missing we silently stay on cache.
  function attachListeners() {
    var fs = window.firebaseFirestore;
    var db = window.firebaseDb;
    if (!fs || !db || !fs.doc || !fs.onSnapshot) return false;
    TABS.forEach(function (tabId) {
      try {
        fs.onSnapshot(
          fs.doc(db, 'venueMenu', tabId),
          function (snap) {
            if (!snap.exists()) return;
            var data = snap.data();
            var cats = Array.isArray(data && data.categories) ? data.categories : [];
            writeCache(tabId, cats);
            applyTab(tabId, cats);
          },
          function (_err) { /* offline — keep cache */ }
        );
      } catch (_e) { /* SDK shape mismatch — keep cache */ }
    });
    return true;
  }
  // Try now, then again after window.load in case the wallet sets up Firebase late.
  if (!attachListeners()) {
    window.addEventListener('load', function () { attachListeners(); });
  }

  // ── 5. PUBLIC API — keep the existing wallet helper compatible ──────────
  // Identical signature/return shape as the original hodGetMenuByTab().
  window.hodGetMenuByTab = function (tab) {
    if (tab === 'food') return window.HOD_FOOD_MENU;
    if (tab === 'smoke') return window.HOD_SMOKE_MENU;
    var split = [];
    (window.HOD_BAR_MENU || []).forEach(function (c) {
      var matched = c.items.filter(function (it) {
        var isNab = it.alc === false;
        return tab === 'nab' ? isNab : !isNab;
      });
      if (matched.length) split.push({ cat: c.cat, items: matched });
    });
    return split;
  };
})();
