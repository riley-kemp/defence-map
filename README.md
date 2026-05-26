# Canadian Defence Manufacturing Industry Map

## Map Objective

This map came about through a project done at the [Trillium Network for Advanced Manufacturing](https://trilliummfg.ca/) to create a complete (or as complete as possible) directory of Canadian defence manufacturers, as well as any defence-related Value-Add/Technology and federally certified Maintenance, Repair, and Overhaul (MRO) facilities. 

The data presented here represents the full depth of the facility data collected, but only a subset of the breadth of the facility data. It is also the case that single companies may have multiple defence facilities.

## Map Data
- [defence_facilities.csv](data/defence_facilities.csv) - is a lookup table mapping facility-level metrics to Canadian census divisions. Facilities were included based on their association to the defence industry, including facility certifications, news reports, union websites, and the websites of the companies themselves. Could this data have been collated and aggregated in a more efficient manner, definitely. Does it work as currently formatted and I'm too afraid to change it at this point, absolutely!
- [Canada_CD.geojson](data/Canada_CD.geojson) - is a GeoJSON spatial data of Canada, divided into census divisions. This data is based off the [2025 Statistics Canada Census Subdivision Boundary File.](https://www12.statcan.gc.ca/census-recensement/2011/geo/bound-limit/bound-limit-s-eng.cfm?year=25) and was aggregated by "CDUID". The GeoJSON has a CRS of EPSG:3347.

## Map
Can be found [here.](https://defencemap.trilliummfg.ca/)
