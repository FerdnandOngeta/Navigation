# Field Navigator — Tutorial

Field Navigator helps you find field sites (schools, clinics, water points, villages) even where
there is no mobile signal. It runs in the phone's browser and installs like an app.

## 1. Install it on your phone

1. Open the app link in **Chrome** (Android) or **Safari** (iPhone) while you have internet.
2. Android: tap the "install" tip or menu **⋮ → Install app**.
   iPhone: tap **Share □↑ → Add to Home Screen**.
3. Open it once from the home-screen icon. From now on it opens with no internet.

Allow **Location** when asked. GPS works without internet, but the first fix in a remote area can
take a minute; stand outside, away from buildings.

## 2. Load your sites

You have three ways to add places:

- **Import a list**: **Places → Import**, then pick a file:
  - **CSV** (from Excel or Google Sheets). Required columns: `name`, `latitude`, `longitude`.
    Optional columns: `category`, `code`, `description`, `landmarks` (directions), and `photo_url`.
    Start from `data/locations-template.csv`. Other common column names also work (`lat`/`lng`,
    `site_name`, `gps_latitude`, and so on).
  - **GeoJSON** points (from QGIS or most GIS tools).
  - A **Field Navigator export** from a colleague, which includes their photos.
- **Tap the map** anywhere → **Save place**.
- **Add tab**: stand at the site and tap **Use my GPS position**.

Importing the same file again updates places with the same `code` instead of duplicating them.

### Checking your data before import

After you pick a CSV or GeoJSON file, a **Check your data** screen opens:

1. **Where are the GPS coordinates?** The app guesses the columns, for example `latitude`,
   `gps-Latitude` or `_gps_latitude`. If your columns have unclear names (`v1`, `col_7`), choose
   them yourself:
   - **Two columns**: one for latitude (north/south) and one for longitude (east/west).
   - **One column**: a single value such as `-0.0917 34.7680 1150 5`, for example a SurveyCTO/ODK
     geopoint.

   Each column in the list shows an example value to help you choose.
2. **The check box** says whether the values really look like GPS coordinates, and explains any
   problems:
   - text instead of numbers
   - missing values, or `0, 0` (a failed GPS reading)
   - values outside ±90 / ±180
   - whole numbers (an ID or count column picked by mistake)
   - latitude and longitude **swapped**, including when the points land far from your other
     places or your location but would be nearby if swapped. The **⇄ Swap** button lights up when
     that's likely.

   Decimal commas (`-0,0917`) and degrees-minutes-seconds (`0°05'30"S`) are understood.
3. **👁 Preview points on map** shows every point as an orange dot so you can see they're in the
   right area.
4. Optionally choose the **name, code, category, directions, notes and photo URL** columns.
5. Tap **Import**. Rows without valid coordinates are skipped and counted. The app remembers your
   choices for the next file with the same columns.

**Every column in the file is kept** with each place, and you can see them under **All data from
import** on the place's page.

## 2b. Datasets: managing places in batches

Each file you import becomes a **dataset**, named after the file (you can rename it on the import
screen). You never have to fix places one by one.

**Overhaul a dataset with a new version of the file:**
1. Open **Places → Datasets → ⟳ Update from new file** and pick the new file. If the new file has
   the same columns as an existing dataset, the import screen picks **Update an existing dataset**
   automatically.
2. The screen shows exactly what will happen, for example "**12** will be updated · **3** added ·
   **2** removed".
   - Places are matched by the **Code / ID** column. Choose one for reliable matching; otherwise
     the same name within 25 m counts as a match.
   - Updated places keep their **photos, landmark photos and visited status**. Only the data
     columns are replaced.
   - Untick **Remove places that are no longer in this file** to keep old places.
3. Tap **Update dataset**. If anything will be removed, you're asked to confirm with the names
   listed first.

**Act on many places at once (Places → ☑ Select):**
- Tick places one by one, or narrow the list with search or the dataset menu, then tap **Select
  all N matching**.
- Then apply an action to all of them:
  - **✓ Visited** / **↺ Not visited**
  - **🏷 Category**
  - **⬇ Offline maps** (satellite close-ups around each one)
  - **🗑 Delete**

**Other dataset actions:**
- **Show only**: lists that dataset and zooms the map to it.
- **Delete dataset**: removes all its places and their photos after a confirmation.

Places you added by hand stay under "Added by hand / older imports" and are never touched by a
dataset update.

## 3. Prepare for the field while you still have signal

Open the **Offline** tab:

- **Download this area**: zoom the map to the area you'll work in, then choose a map style and
  zoom range. The app shows the size before downloading. Zoom 12–16 is a good balance; 17–18
  shows individual buildings.
- **Save map along current route**: after you start navigating, this saves a 400 m corridor along
  the road route.
- **Save aerial view around all places**: saves a satellite close-up around every saved site.
- **Protect saved maps from clean-up**: stops the phone from deleting maps when storage is low.

Maps you look at while online are also kept automatically. If a download is interrupted by a weak
signal, tap Download again; it skips what's already saved.

## 4. Find a place

- Type in the **search bar**. Saved places match instantly, offline too, on **any column** of
  your imported data (district, ward, enumerator, household ID and so on). Each result shows which
  column matched.
- To search one column, type `column:value`, e.g. `district:kisumu`. Use quotes for spaces:
  `ward:"kolwa east"`. Combine words to narrow down: `district:kisumu enumerator:achieng`.
- In the **Places** tab, the **Search in** menu limits the search to one column.
- Press **Enter** to also search addresses online (needs signal).
- Type coordinates such as `-0.0420, 34.8890` to jump to a spot.
- The **Places** tab lists all sites, nearest first, with distance and direction.

## 5. Navigate

Open a place, choose **Walk**, **Bike** or **Vehicle**, choose where you're **Starting from**,
then tap **▶ Navigate here**.

**Starting from** options:
- **My current location (GPS)**: the default.
- **A saved place**, for example the office or a base camp.
- **Pick a point on the map**: after tapping Navigate, tap the map where the trip starts.
- **A dropped pin**: tap the map → **Start trip from here**, then open the destination.

Planning from somewhere else is useful before you leave. While you have internet and no GPS fix,
plan "Office → Site", then use **Offline → Save map along current route**. The route is saved, and
when you start from that point later it's reused offline. The blue **A** marker shows the start.

When you choose a start point other than your own location, **all distances are measured between
the start point and the destination**, not from where you're standing:
- The place page shows, for example, "17 km ENE of Kisumu Town Office" as soon as you pick the
  start.
- The panel shows the road distance from the start (e.g. **21 km**), the straight-line distance,
  the direction from the start, and the travel time for the whole trip.
- Only the line "Go to the start: 2.7 km SSE of you" and the arrow use your own position, to get
  you to the start.
- Once you reach the start (or anywhere on the route), the panel switches to live turn-by-turn
  guidance from where you are. Arrival is always detected from your real GPS position.

The green panel at the top shows:
- **Distance**: by road while you're on the road, otherwise straight-line.
- **The arrow**: points toward the destination. Tap it once to switch on the compass (iPhone asks
  for permission). With the compass on, hold the phone flat and walk where the arrow points.
  Without a compass the arrow shows the direction on the north-up map.
- **Next instruction**, such as "In 300 m: Turn left onto …".
- **Orange warnings**: "Off the route" (the app re-routes when online) or "Leave the road: 600 m NE
  on foot". The orange dashed line on the map is that last stretch from the road to the site.

**Nearest places**: whenever the phone has a GPS fix, a small table above the tab bar lists the
**3 loaded places closest to you**. Each row shows the distance, an arrow and the compass
direction. It re-sorts as you travel, so you can see what you're passing or what's just off the
road. Your destination is marked ★ and visited places are greyed out. Tap a row to open that
place. Tap the green header to shrink the table to a single line. You can turn it off in
Settings.

With no signal you still get the arrow, distance and your recorded path (purple line). A road
route fetched earlier for that place is reused automatically.

**Arriving**: within the arrival distance (40 m by default) the phone vibrates and shows the
site's photos, aerial view and recognition notes. Tap **Mark visited**.

## 6. Photos that help the next person

- **Photos of the place** (gate, signboard, building): open the place → **📷 Add photo**. The first
  photo becomes the place's map pin.
- **Landmark photos on the way** (a junction, a church, a big tree): while navigating, tap
  **📷 Landmark**. The photo is pinned where you're standing. When the next person comes within
  150 m of it, their phone vibrates and shows the photo with your caption.
- **From above**: every place shows a satellite close-up with the exact spot marked. It's saved
  automatically when you add a place online, or with **⬇ Save area**.

Photos are compressed on the phone, about 150–250 KB each.

## 7. Share with your team

**Places → Export**:
- **With photos**: complete, but a larger file. Send it over Wi-Fi, USB or Bluetooth.
- **List only**: a tiny file that's easy to send over a weak connection.
- **CSV**: to open in Excel. Includes a `visited` column for reporting.

On phones, Export opens the share menu (WhatsApp, email, Drive and so on). Colleagues import the
file from **Places → Import**.

**↗ Share** on a single place copies its name, coordinates, directions and a map link for SMS or
chat.

## 8. Settings

- **Map detail**:
  - **Auto** (recommended): satellite detail on good signal, light maps on weak signal.
  - **Light**: always saves data.
  - **Detailed**: always uses imagery when online.
- **Map style**: Auto, Streets, Terrain (contours, good for hills and footpaths) or Satellite.
  The layers button on the map cycles through these.
- **Arrival alert distance**: increase it where GPS is poor (dense forest, valleys).
- **Custom tile server**: for large offline downloads, ask your IT/GIS team for a tile URL.
- **Recorded tracks**: view your path from a trip, or export it as **GPX** for GIS or reporting.

The pill at the top right shows the connection: **Good**, **Fair**, **Weak** or **Offline**. Tap it
to open the Offline tab.

## Tips for remote work

- Before each trip, while on Wi-Fi: open each destination once and use **Save area**, or use
  **Save map along current route**.
- Charge the phone. GPS and an always-on screen drain the battery; a car charger or power bank
  helps.
- In poor GPS (forest, valleys), wait for "GPS ±" to drop below about 20 m before trusting the
  last 50 m.
- Write good **"How to recognise it"** notes. They're the first thing shown on arrival.
