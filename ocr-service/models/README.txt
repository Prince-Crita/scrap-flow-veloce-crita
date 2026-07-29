Drop model weight files here.

license_plate_detector.pt — dedicated plate detector (optional, biggest accuracy
gain). Without it, plate localisation falls back to classical morphology.
yolov8n.pt — vehicle localisation; auto-downloaded by ultralytics on first use.

The service resolves weights from this directory first and re-checks on every
request until one loads, so dropping a file in here upgrades accuracy with no
code change and no restart. GET /health reports models_dir, plate_model_expected
and plate_model_found.
