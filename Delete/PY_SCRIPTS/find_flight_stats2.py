"""
Find all flight performance values in the Gladius vehicle XML.
Run: python find_flight_stats2.py
"""
from pathlib import Path
from xml.etree import ElementTree as ET
import re

VEHICLE = Path(r"E:\VerseDB\sc_data_xml\Data\Scripts\Entities\Vehicles\Implementations\Xml")

for xml_file in VEHICLE.glob("*.xml"):
    if 'gladius' not in xml_file.name.lower():
        continue
    root = ET.parse(xml_file).getroot()
    print(f"=== {xml_file.name} ===")

    # IFCSParams
    for el in root.iter("IFCSParams"):
        print("\nIFCSParams:", dict(el.attrib))

    # SStandardFlightModel / flight model
    for el in root.iter():
        tag = el.tag.lower()
        if any(x in tag for x in ['flightmodel','flightparam','ifcs','scm','speed','velocity','thrust']):
            if el.attrib:
                print(f"\n<{el.tag}>:", dict(el.attrib))

    # SStandardFlightModel
    for el in root.iter("SStandardFlightModel"):
        print("\nSStandardFlightModel:", dict(el.attrib))

    # Params with SCM/speed/angular values
    for el in root.iter():
        for k, v in el.attrib.items():
            if any(x in k.lower() for x in ['scm','angular','pitch','yaw','roll','maxspeed',
                                              'navspeed','boostspeed','linearspeed','maxthrust',
                                              'afterburner','maxangular']):
                print(f"  {el.tag}.{k} = {v}")
    break

# Also check what attrs the main vehicle part has
print("\n=== Main vehicle part attrs ===")
for xml_file in VEHICLE.glob("*.xml"):
    if 'gladius' not in xml_file.name.lower(): continue
    root = ET.parse(xml_file).getroot()
    # Root element
    print(f"Root: <{root.tag} {dict(list(root.attrib.items())[:10])}>")
    # Vehicle element
    for el in root.iter("Vehicle"):
        print(f"Vehicle: {dict(el.attrib)}")
    for el in root.iter("Params"):
        print(f"Params: {dict(el.attrib)}")
    break
