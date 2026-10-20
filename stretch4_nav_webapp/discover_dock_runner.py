#!/usr/bin/env python3
"""Run stretch_nav2's discover_dock node, saving what it finds to a file we choose.

Launched by dock_discovery.py inside a ROS-sourced shell (it imports
stretch_nav2, so it is never imported by the webapp itself)::

    python3 discover_dock_runner.py --db /path/to/session_docks.yaml

"""

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="dock database file to write")
    args, ros_args = parser.parse_known_args()

    from stretch_nav2 import dock_database

    db_path = args.db
    dock_database.DockDatabase._get_db_filepath = lambda self, map_name: db_path

    from stretch_nav2 import discover_dock

    discover_dock.main(args=[sys.argv[0], *ros_args])


if __name__ == "__main__":
    main()
