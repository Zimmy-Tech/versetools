"""
Investigate acceleration/Gs data in the IFCS flight controller XML.
Run: python find_accel.py
"""
from pathlib import Path
from xml.etree import ElementTree as ET

FORGE = Path(r"/mnt/e/VerseDB/sc_data_forge/libs/foundry/records")
ctrl_dir = FORGE / "entities" / "scitem" / "ships" / "controller"

def dump_ship(ship_lower):
    fc_file = ctrl_dir / f"controller_flight_{ship_lower}.xml.xml"
    if not fc_file.exists():
        candidates = sorted(ctrl_dir.glob(f"controller_flight_{ship_lower}*.xml.xml"))
        base = [f for f in candidates
                if not any(x in f.stem for x in ("blade", "_mm_", "rework", "_pu_"))]
        fc_file = base[0] if base else (candidates[0] if candidates else None)
    if not fc_file:
        print(f"No controller file found for {ship_lower}")
        return

    print(f"\n=== {fc_file.name} ===")
    root = ET.parse(fc_file).getroot()
    ifcs = root.find(".//IFCSParams")
    if ifcs is None:
        print("No IFCSParams found")
        return

    print("IFCSParams attrs:", dict(ifcs.attrib))
    print("\nIFCSParams children:")
    for child in ifcs:
        print(f"  <{child.tag} {dict(child.attrib)}>")
        for sub in child:
            print(f"    <{sub.tag} {dict(sub.attrib)}>")

for ship in ["aegs_gladius", "anvl_hornet_f7cm_mkii", "orig_300i"]:
    dump_ship(ship)
