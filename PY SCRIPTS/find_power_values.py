"""
Investigate power assignment values for coolers (and components in general).
Goal: find min power draw (standby/idle) and max power draw (online/active).
Run: python3 find_power_values.py
"""
from pathlib import Path
from xml.etree import ElementTree as ET
import re

FORGE = Path("/mnt/e/VerseDB/sc_data_forge/libs/foundry/records")
cool_dir = FORGE / "entities" / "scitem" / "ships" / "cooler"

def dump_power_states(f):
    root = ET.parse(f).getroot()
    print(f"\n=== {f.stem} ===")

    # Print all ItemResourceState elements and their children
    for state in root.iter("ItemResourceState"):
        name = state.get("name", "?")
        print(f"  ItemResourceState name={name!r}")
        for child in state.iter():
            if child is state:
                continue
            attrs = dict(child.attrib)
            if attrs:
                print(f"    <{child.tag} {attrs}>")

    # Also look for SItemPowerConnection or SCItemPowerConsumerComponentParams
    for tag in ("SItemPowerConnection", "SCItemPowerConsumerComponentParams",
                "PowerConsumer", "powerConsumer", "SItemPowerRequirements",
                "powerRequirements", "SItemElectronicComponentParams"):
        for el in root.iter(tag):
            print(f"  <{tag} {dict(el.attrib)}>")
            for child in el:
                if child.attrib:
                    print(f"    <{child.tag} {dict(child.attrib)}>")

# Sample a few coolers across sizes/classes
targets = []
for f in sorted(cool_dir.glob("*.xml")):
    stem = f.stem.lower()
    if any(x in stem for x in ("iceplunge", "bracer", "snowpack", "thermalcore", "lightweave")):
        targets.append(f)

if not targets:
    targets = sorted(cool_dir.glob("*.xml"))[:5]

for f in targets[:6]:
    dump_power_states(f)
