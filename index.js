const fs = require('fs-extra');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const youtubedl = require('youtube-dl-exec');

// Directory containing the files
const srcDir = path.join(__dirname, 'src');
const exoBackupDir = path.join(__dirname, 'exo_backup'); // Directory to move .exo files to

// SQLite database file path
const dbPath = path.join(__dirname, 'exoplayer_internal.db');

// Connect to the SQLite database
const db = new sqlite3.Database(dbPath);

async function getVideoTitle(uri) {
  try {
    console.log(`Fetching title for URI: ${uri}`);
    const result = await youtubedl(uri, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      skipDownload: true,
    });
    console.log(`Retrieved title: ${result.title}`);
    return result.title;
  } catch (error) {
    console.error(`Error fetching title for URI: ${uri}`, error);
    return null;
  }
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-');
}

async function moveExoFiles() {
  try {
    console.log('Ensuring exo backup directory exists...');
    await fs.ensureDir(exoBackupDir);

    console.log('Searching src directory recursively for .exo files...');

    const copyFilesRecursively = async (dir) => {
      try {
        const items = await fs.readdir(dir, { withFileTypes: true });

        for (const item of items) {
          const itemPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            console.log(`Entering directory: ${itemPath}`);
            await copyFilesRecursively(itemPath);
          } else if (path.extname(item.name) === '.exo') {
            const newFilePath = path.join(exoBackupDir, item.name);
            await fs.copy(itemPath, newFilePath);
            console.log(`Copied ${itemPath} to ${newFilePath}`);
          }
        }
      } catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
      }
    };

    await copyFilesRecursively(srcDir);

    console.log('Completed copying files.');

  } catch (error) {
    console.error('Error copying .exo files:', error);
  }
}

async function processFiles() {
  try {
    // Copy .exo files before processing
    await moveExoFiles();

    console.log('Reading exo_backup directory for files...');
    const files = await fs.readdir(exoBackupDir);

    if (files.length === 0) {
      console.log('No files found in exo_backup directory.');
      return;
    }

    console.log(`Found ${files.length} files in exo_backup. Processing...`);

    db.serialize(() => {
      db.all(`SELECT name, length FROM ExoPlayerCacheFileMetadata44519d37edfdb77`, async (err, rows) => {
        if (err) {
          console.error('Error reading ExoPlayerCacheFileMetadata:', err);
          return;
        }

        if (rows.length === 0) {
          console.log('No rows found in ExoPlayerCacheFileMetadata44519d37edfdb77.');
          return;
        }

        console.log(`Found ${rows.length} rows in ExoPlayerCacheFileMetadata44519d37edfdb77. Processing...`);

        for (const row of rows) {
          const { name, length } = row;

          db.get(`SELECT uri FROM ExoPlayerDownloads WHERE content_length = ?`, [length], async (err, downloadRow) => {
            if (err) {
              console.error('Error reading ExoPlayerDownloads:', err);
              return;
            }

            if (!downloadRow) {
              console.log(`No matching entry in ExoPlayerDownloads for length: ${length}`);
              return;
            }

            const { uri } = downloadRow;

            // Step 3: Use uri to get YouTube (video/music) name
            let title = await getVideoTitle(uri);
            if (title) {
              title = sanitizeFilename(title);

              // Step 4: Rename all files in exo_backup to title.m4a
              const oldFilePath = path.join(exoBackupDir, name);
              const newFileName = `${title}.m4a`;
              const newFilePath = path.join(exoBackupDir, newFileName);

              if (files.includes(name)) {
                await fs.rename(oldFilePath, newFilePath);
                console.log(`Renamed ${name} to ${newFileName}`);
              } else {
                console.log(`File ${name} not found in exo_backup directory.`);
              }
            } else {
              console.log(`Could not retrieve title for URI: ${uri}`);
            }
          });
        }
      });
    });
  } catch (error) {
    console.error('Error processing files:', error);
  } finally {
    db.close(() => {
      console.log('Database connection closed.');
    });
  }
}

processFiles();
